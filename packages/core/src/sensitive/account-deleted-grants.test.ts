import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markUserDeleted, markUserRestored } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessGrant, type AccessConsent } from './access-grants.js';
import {
  AccessGrantRefusedError,
  AccountDeletedError,
  SensitiveAccessDeniedError,
} from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { readSensitive, writeSensitive } from './service.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  seedProfileHolder,
  type AccessScene,
} from './test-support.js';

/**
 * Grants and a deleted account (decision D-69, P-02l2). A grant is derived from the account
 * of the person who makes it, so `createAccessGrant` for an account holder holds the user row
 * `FOR KEY SHARE` and refuses an account that is deleted (`AccountDeletedError`, 422
 * `account-deleted`); and a grant is live only while that account, if the person has one, is
 * not deleted, so the grants of a deleted account open nothing even before anything ends
 * them. The medical record is the organisation's and outlives the account, so the second rule
 * is what keeps a deleted account's medical grant from opening it. The rule is read from the
 * rows as they are, so restoring the account makes the grants that were not ended live again.
 */

const MEDICAL = VALID_PAYLOADS.medical;
const CONSENT: AccessConsent = {
  method: 'in-person',
  at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
};

/** One field of each category a grant can name, and what the producer reads when it is open. */
const CATEGORIES = [
  ['accessibility', 'stepFreeRequired', { stepFreeRequired: true }],
  ['medical', 'conditions', { conditions: 'Asthma' }],
] as const;

describe.each(testTargets)(
  'grants and a deleted account on $name',
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
    /** A person with an account, on the project, with a profile and the organisation's medical record. */
    const newHolder = async () => {
      const holder = await seedProfileHolder(database, scene, 'Ines Kovac');
      await writeSensitive(
        db(),
        ctxFor(holder.userId),
        holder.personId,
        'medical',
        MEDICAL,
        { legalBasis: 'consent' },
      );
      return holder;
    };
    type Holder = Awaited<ReturnType<typeof newHolder>>;

    /** The person grants `fields` of a category to the production role. */
    const grant = (
      who: Holder,
      category: 'accessibility' | 'medical',
      fields: string[],
    ) =>
      createAccessGrant(db(), ctxFor(who.userId), {
        projectId: scene.projectId,
        personId: who.personId,
        category,
        roleId: scene.roles.production,
        fields,
      });
    const errorOf = (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => undefined,
        (error: unknown) => error,
      );
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant))
        .filter((row) => row.personId === personId)
        .sort((a, b) => a.id.localeCompare(b.id));
    const refusalsAbout = async (personId: string) =>
      (await db().select().from(auditEvent))
        .filter(
          (event) =>
            event.category === 'access.refused' && event.targetId === personId,
        )
        .sort((a, b) => a.id.localeCompare(b.id));
    /** What the producer, who holds the read permissions, reads of a person's data, or `denied`. */
    const producerSees = async (
      personId: string,
      category: 'accessibility' | 'medical',
    ) => {
      try {
        return (
          (
            await readSensitive(
              db(),
              ctxFor(scene.users.producer),
              personId,
              category,
            )
          )?.payload ?? null
        );
      } catch (error) {
        if (error instanceof SensitiveAccessDeniedError) return 'denied';
        throw error;
      }
    };

    it.each(CATEGORIES)(
      'refuses a %s grant for an account that is deleted, with the reason in an event, and writes no grant',
      async (category, field) => {
        const ines = await newHolder();
        await markUserDeleted(database, ines.userId);

        const refused = await errorOf(grant(ines, category, [field]));

        expect(refused).toBeInstanceOf(AccountDeletedError);
        // It is its own error, not one of the refusals that carry a reason.
        expect(refused).not.toBeInstanceOf(AccessGrantRefusedError);
        expect(await grantsOf(ines.personId)).toEqual([]);
        const events = await refusalsAbout(ines.personId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ action: 'account-deleted' });
        // The reason code and the category, as for every refusal: no field, no value.
        expect(events[0]!.details).toEqual({
          reason: 'account-deleted',
          category,
        });
      },
    );

    it('leaves the grant it would have replaced as it was, and lets the person grant again once the account is restored', async () => {
      const ines = await newHolder();
      await grant(ines, 'accessibility', ['stepFreeRequired']);
      // A deleted account whose sharing nobody ended: its grant is still a row, live or not.
      await markUserDeleted(database, ines.userId);

      const refused = await errorOf(
        grant(ines, 'accessibility', ['quietSpace']),
      );

      expect(refused).toBeInstanceOf(AccountDeletedError);
      const rows = await grantsOf(ines.personId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fields: ['stepFreeRequired'],
        revokedAt: null,
        version: 1,
      });

      await markUserRestored(database, ines.userId);
      const made = await grant(ines, 'accessibility', ['quietSpace']);
      expect(made.replaced).toBe(true);
    });

    it.each(CATEGORIES)(
      'opens a %s grant to nobody while the account is deleted, and again when the account is restored',
      async (category, field, opens) => {
        const ines = await newHolder();
        await grant(ines, category, [field]);
        expect(await producerSees(ines.personId, category)).toEqual(opens);

        // The grant is still a row, never revoked, and not live: the deleted account is a
        // reason it is not, worked out when it is read.
        await markUserDeleted(database, ines.userId);
        expect(await producerSees(ines.personId, category)).toBe('denied');
        expect(await grantsOf(ines.personId)).toMatchObject([
          { revokedAt: null },
        ]);

        await markUserRestored(database, ines.userId);
        expect(await producerSees(ines.personId, category)).toEqual(opens);
      },
    );

    it('does not touch a person without an account: staff record their grant and it opens as before', async () => {
      const crew = scene.people.crew.personId;
      await writeSensitive(
        db(),
        ctxFor(scene.users.coordinator),
        crew,
        'accessibility',
        VALID_PAYLOADS.accessibility,
        { legalBasis: 'consent' },
      );
      await createAccessGrant(db(), ctxFor(scene.users.coordinator), {
        projectId: scene.projectId,
        personId: crew,
        category: 'accessibility',
        roleId: scene.roles.production,
        fields: ['stepFreeRequired'],
        consent: CONSENT,
      });

      expect(await producerSees(crew, 'accessibility')).toEqual({
        stepFreeRequired: true,
      });
    });
  },
);
