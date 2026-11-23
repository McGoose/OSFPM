import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base } from '../access/test-fixtures.js';
import { markUserDeleted } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent, settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { shareWithSuggestedRoles } from './access-grants.js';
import { AccountDeletedError } from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { writeSensitive } from './service.js';
import { ACCESS_SUGGESTED_ROLES_SETTING } from './suggested-roles.js';
import {
  ctxFor,
  seedAccessScene,
  seedProfileHolder,
  type AccessScene,
} from './test-support.js';

/**
 * A share with the usual roles for an account that is deleted is refused, as a grant is
 * (decision D-69, P-02l2): `AccountDeletedError`, 422 `account-deleted`, audited as
 * `access.refused` with that reason before it is thrown. It holds the person's user row
 * `FOR KEY SHARE` once its other checks have passed, before it reads anything of theirs. A
 * grant made after the account's sharing was ended would be live for a deleted account, and
 * open it again on a restore. The accessibility profile is gone with the account and would
 * show the same on its own; the medical record is the organisation's and stays, so only the
 * check of the account stops a medical share. A preview is refused too, so a client is never
 * shown a share that a confirmed call would refuse.
 */
describe.each(testTargets)(
  'sharing with the usual roles for a deleted account on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    /** The organisation usually shares both categories with the production role. */
    const suggestedRoles = () => ({
      ...base(scene.organisationId),
      layer: 'org' as const,
      projectId: null,
      key: ACCESS_SUGGESTED_ROLES_SETTING,
      value: {
        physical: [scene.roles.production],
        medical: [scene.roles.production],
      },
    });

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
      await database.db.insert(settingValue).values(suggestedRoles());
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const newHolder = async () => {
      const holder = await seedProfileHolder(database, scene, 'Ines Kovac');
      // The organisation's medical record, which the account's deletion does not erase.
      await writeSensitive(
        db(),
        ctxFor(holder.userId),
        holder.personId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'consent' },
      );
      return holder;
    };
    type Holder = Awaited<ReturnType<typeof newHolder>>;
    const share = (
      who: Holder,
      category: 'accessibility' | 'medical',
      preview = false,
    ) =>
      shareWithSuggestedRoles(
        db(),
        ctxFor(who.userId),
        scene.projectId,
        who.personId,
        category,
        { preview },
      );
    const errorOf = (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => undefined,
        (error: unknown) => error,
      );
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    /** The events about a person with this category, by id. */
    const eventsAbout = async (personId: string, categories: string[]) =>
      (await db().select().from(auditEvent))
        .filter(
          (event) =>
            event.targetId === personId && categories.includes(event.category),
        )
        .sort((a, b) => a.id.localeCompare(b.id));

    it.each(['accessibility', 'medical'] as const)(
      'refuses a %s share for a deleted account with AccountDeletedError, audits the refusal, and writes no grant',
      async (category) => {
        const ines = await newHolder();
        await markUserDeleted(database, ines.userId);

        const refused = await errorOf(share(ines, category));

        expect(refused).toBeInstanceOf(AccountDeletedError);
        expect(await grantsOf(ines.personId)).toEqual([]);
        // The refusal is audited with its reason code and the category, as every refusal of
        // a grant is, and nothing was read or shared: no shortcut event, no read event.
        const refusals = await eventsAbout(ines.personId, ['access.refused']);
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatchObject({ action: 'account-deleted' });
        expect(refusals[0]!.details).toEqual({
          reason: 'account-deleted',
          category,
        });
        expect(
          await eventsAbout(ines.personId, [
            'access.shortcut-used',
            'sensitive.read',
          ]),
        ).toEqual([]);
      },
    );

    it.each(['accessibility', 'medical'] as const)(
      'refuses a %s preview for a deleted account too, so a client is not shown a share that a confirmed call would refuse',
      async (category) => {
        const ines = await newHolder();
        await markUserDeleted(database, ines.userId);

        const refused = await errorOf(share(ines, category, true));

        expect(refused).toBeInstanceOf(AccountDeletedError);
        expect(await grantsOf(ines.personId)).toEqual([]);
      },
    );

    it('refuses a deleted account before it answers that no role is suggested', async () => {
      const ines = await newHolder();
      await markUserDeleted(database, ines.userId);
      // The organisation has not chosen the usual roles: the answer would be an empty preview.
      await db()
        .delete(settingValue)
        .where(eq(settingValue.key, ACCESS_SUGGESTED_ROLES_SETTING));
      try {
        expect(await errorOf(share(ines, 'medical'))).toBeInstanceOf(
          AccountDeletedError,
        );
      } finally {
        await db().insert(settingValue).values(suggestedRoles());
      }
    });

    it.each([
      ['accessibility', ['stepFreeRequired', 'maxWalkMetres']],
      ['medical', ['conditions', 'medication']],
    ] as const)(
      'still shares for an account that is live, as before, for a %s share',
      async (category, fields) => {
        const ines = await newHolder();

        const result = await share(ines, category);

        expect(result).toMatchObject({ preview: false, granted: 1 });
        const rows = await grantsOf(ines.personId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ category, revokedAt: null });
        expect(rows[0]!.fields.slice().sort()).toEqual(
          expect.arrayContaining(fields.slice().sort()),
        );
      },
    );
  },
);
