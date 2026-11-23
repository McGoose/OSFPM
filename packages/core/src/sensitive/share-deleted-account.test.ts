import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base } from '../access/test-fixtures.js';
import { markUserDeleted } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent, settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { shareWithSuggestedRoles } from './access-grants.js';
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
 * A share with the usual roles for an account that is deleted shares nothing (decision D-69,
 * P-02l2). It holds the person's user row `FOR KEY SHARE` before it reads anything of theirs,
 * and when the account is deleted it writes no grant and no event, whichever category it was
 * asked about: a grant made after the account's sharing was ended would be live for a deleted
 * account, and open it again on a restore. The accessibility profile is gone with the account
 * and would show the same on its own; the medical record is the organisation's and stays, so
 * only the check of the account stops a medical share.
 */
describe.each(testTargets)(
  'sharing with the usual roles for a deleted account on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
      // The organisation usually shares both categories with the production role.
      await database.db.insert(settingValue).values({
        ...base(scene.organisationId),
        layer: 'org',
        projectId: null,
        key: ACCESS_SUGGESTED_ROLES_SETTING,
        value: {
          physical: [scene.roles.production],
          medical: [scene.roles.production],
        },
      });
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
    const share = (who: Holder, category: 'accessibility' | 'medical') =>
      shareWithSuggestedRoles(
        db(),
        ctxFor(who.userId),
        scene.projectId,
        who.personId,
        category,
      );
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    const eventsAbout = async (personId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.targetId === personId &&
          (event.category === 'access.shortcut-used' ||
            event.category === 'sensitive.read'),
      );

    it.each(['accessibility', 'medical'] as const)(
      'shares nothing for a deleted account, and writes no grant and no event, for a %s share',
      async (category) => {
        const ines = await newHolder();
        await markUserDeleted(database, ines.userId);

        const result = await share(ines, category);

        expect(result).toEqual({ preview: false, shares: [], granted: 0 });
        expect(await grantsOf(ines.personId)).toEqual([]);
        expect(await eventsAbout(ines.personId)).toEqual([]);
      },
    );

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
