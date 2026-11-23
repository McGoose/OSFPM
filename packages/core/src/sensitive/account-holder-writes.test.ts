import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { auditEvent, person } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessProfile } from './access-profile.js';
import {
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
  UseAccessProfileError,
} from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { deleteSensitive, readSensitive, writeSensitive } from './service.js';
import {
  ctxFor,
  seedAccessScene,
  tokenFor,
  type AccessScene,
} from './test-support.js';

/**
 * Where a person's adjustments are kept (decision D-69): a person with an account keeps them
 * in their access profile, so a production record of them cannot be written, by the person
 * or by staff, and is refused with a code that says where to go. A person without an account
 * has the production's record, entered by staff in the structured shape. Medical data stays
 * a production record for everyone.
 */

const OPTIONS = { legalBasis: 'consent' } as const;

describe.each(testTargets)(
  'writing a person’s adjustments on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const holder = () => scene.people.holder;
    const crew = () => scene.people.crew;
    const rowsOf = async (personId: string, category: string) =>
      (
        (await db().execute(
          sql`select id from person_sensitive where person_id = ${personId} and category = ${category}`,
        )) as { rows: unknown[] }
      ).rows;
    const errorOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );
    const refusals = async () =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === 'access.refused',
      );

    describe('for a person with an account', () => {
      it('refuses the person’s own write of an accessibility record, and says to use the profile, and audits it', async () => {
        const seen = (await refusals()).length;
        const refused = await errorOf(
          writeSensitive(
            db(),
            ctxFor(holder().userId),
            holder().personId,
            'accessibility',
            VALID_PAYLOADS.accessibility,
            OPTIONS,
          ),
        );
        expect(refused).toBeInstanceOf(UseAccessProfileError);
        expect(await rowsOf(holder().personId, 'accessibility')).toEqual([]);
        const [event] = (await refusals()).slice(seen);
        expect(event).toMatchObject({
          action: 'write',
          actorId: holder().userId,
          targetId: holder().personId,
          details: { reason: 'use-access-profile', category: 'accessibility' },
        });
        expect(JSON.stringify(event)).not.toContain('hr-HR-SL');
      });

      it('refuses staff who edit the same, once it has checked they may', async () => {
        await expect(
          writeSensitive(
            db(),
            ctxFor(scene.users.coordinator),
            holder().personId,
            'accessibility',
            VALID_PAYLOADS.accessibility,
            OPTIONS,
          ),
        ).rejects.toBeInstanceOf(UseAccessProfileError);
        // Someone who may not write at all is denied, not told where the data lives.
        for (const other of [
          scene.users.producer,
          scene.users.owner,
          scene.users.stranger,
        ]) {
          await expect(
            writeSensitive(
              db(),
              ctxFor(other),
              holder().personId,
              'accessibility',
              VALID_PAYLOADS.accessibility,
              OPTIONS,
            ),
          ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        }
        expect(await rowsOf(holder().personId, 'accessibility')).toEqual([]);
      });

      it('refuses it through a token as well, and a payload that is wrong is not looked at first', async () => {
        const token = tokenFor(
          scene.organisationId,
          ['sensitive:edit:accessibility'],
          { access: 'write' },
        );
        await expect(
          writeSensitive(
            db(),
            ctxFor(scene.users.coordinator, { credential: token }),
            holder().personId,
            'accessibility',
            { diagnosis: 'not a field' },
            OPTIONS,
          ),
        ).rejects.toBeInstanceOf(UseAccessProfileError);
      });

      it('still lets the person and staff write their medical data', async () => {
        await writeSensitive(
          db(),
          ctxFor(holder().userId),
          holder().personId,
          'medical',
          VALID_PAYLOADS.medical,
          OPTIONS,
        );
        await writeSensitive(
          db(),
          ctxFor(scene.users.coordinator),
          holder().personId,
          'medical',
          { ...VALID_PAYLOADS.medical, notes: 'Updated by staff' },
          OPTIONS,
        );
        expect(await rowsOf(holder().personId, 'medical')).toHaveLength(1);
      });
    });

    describe('for a person without an account', () => {
      it('is the production’s record, in the structured shape, entered by staff who edit', async () => {
        const meta = await writeSensitive(
          db(),
          ctxFor(scene.users.coordinator),
          crew().personId,
          'accessibility',
          VALID_PAYLOADS.accessibility,
          OPTIONS,
        );
        expect(meta).toMatchObject({
          category: 'accessibility',
          enteredByKind: 'staff',
          enteredBy: scene.users.coordinator,
        });
        const read = await readSensitive(
          db(),
          ctxFor(scene.users.coordinator),
          crew().personId,
          'accessibility',
        );
        expect(read?.payload).toEqual(VALID_PAYLOADS.accessibility);
      });

      it('refuses a record in the shape it had before, and any key that is not an adjustment', async () => {
        for (const payload of [
          { needs: 'Step-free access to trailer', notes: 'Ground floor' },
          { diagnosis: 'x' },
          {},
        ]) {
          await expect(
            writeSensitive(
              db(),
              ctxFor(scene.users.coordinator),
              crew().personId,
              'accessibility',
              payload,
              OPTIONS,
            ),
          ).rejects.toBeInstanceOf(SensitivePayloadInvalidError);
        }
      });
    });

    describe('when a person with a record gets an account', () => {
      it('refuses a new record, reads the profile and not the old record, and lets staff delete the old one', async () => {
        const newcomer = await seedUser(database);
        const personId = crew().personId;
        await db()
          .update(person)
          .set({ userId: newcomer })
          .where(eq(person.id, personId));
        // The record staff wrote before there was an account is still there, and is nobody's now.
        expect(await rowsOf(personId, 'accessibility')).toHaveLength(1);
        await expect(
          writeSensitive(
            db(),
            ctxFor(scene.users.coordinator),
            personId,
            'accessibility',
            VALID_PAYLOADS.accessibility,
            OPTIONS,
          ),
        ).rejects.toBeInstanceOf(UseAccessProfileError);
        const profile = { stepFreeRequired: true };
        await createAccessProfile(db(), ctxFor(newcomer), newcomer, profile);
        const own = await readSensitive(
          db(),
          ctxFor(newcomer),
          personId,
          'accessibility',
        );
        expect(own?.payload).toEqual(profile);
        // Staff no longer read it as a whole: they are staff for a person with an account.
        await expect(
          readSensitive(
            db(),
            ctxFor(scene.users.coordinator),
            personId,
            'accessibility',
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        // Erasing the old record is allowed: it only takes data away.
        await deleteSensitive(
          db(),
          ctxFor(scene.users.coordinator),
          personId,
          'accessibility',
        );
        expect((await rowsOf(personId, 'accessibility')).length).toBe(1);
        const stored = (await db().execute(
          sql`select payload from person_sensitive where person_id = ${personId} and category = 'accessibility'`,
        )) as { rows: { payload: unknown }[] };
        expect(stored.rows[0]!.payload).toBeNull();
      });
    });
  },
);
