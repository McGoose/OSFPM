import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantOnOrganisation,
  seedOrganisation,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  accessReset,
  apiToken,
  changeEvent,
  changeSeq,
  invite,
  inviteRole,
  role,
  session,
} from './schema/index.js';
import { createMigratedDatabase, testTargets } from './test-support.js';
import {
  insertRecord,
  restoreRecord,
  SecurityTableWriteError,
  softDeleteRecord,
  updateRecord,
  type WriteContext,
} from './write.js';

/**
 * The write helper refuses every security table, and the child table of one,
 * even `invite`, `invite_role`, `access_reset` and `api_token`, which carry an
 * `organisation_id` by declaration (CLAUDE.md, Data rules): only the auth service writes them,
 * directly, and audits instead of change-logging. A table with an
 * `organisation_id` is otherwise one the helper would take, so the refusal is
 * its own check and not a side effect of a missing column.
 */

const ORIGIN = newId();

const ctx = (): WriteContext => ({
  actor: { type: 'system', id: null },
  originServer: ORIGIN,
  clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
});

describe.each(testTargets)(
  'the write helper and security tables on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;
    let roleId: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      ({ organisationId } = await seedOrganisation(database));
      const [created] = await database.db
        .insert(role)
        .values({
          organisationId,
          ownerOrgId: organisationId,
          originServer: ORIGIN,
          projectId: null,
          key: 'crew',
          name: 'Crew',
        })
        .returning();
      roleId = created!.id;
    });
    afterAll(async () => {
      await cleanup();
    });

    /** Nothing was written anywhere the helper writes: no row, no event, no counter. */
    const untouched = async () => ({
      invites: (await database.db.select().from(invite)).length,
      links: (await database.db.select().from(inviteRole)).length,
      resets: (await database.db.select().from(accessReset)).length,
      tokens: (await database.db.select().from(apiToken)).length,
      events: (await database.db.select().from(changeEvent)).length,
      counters: (await database.db.select().from(changeSeq)).length,
    });

    const inviteValues = () => ({
      organisationId,
      tokenHash: `write-helper-${newId()}`,
      tier: 'member' as const,
      expiresAt: new Date(Date.UTC(2026, 0, 8)),
    });

    it('refuses to insert an invite, though it has an organisation_id, and writes nothing', async () => {
      const before = await untouched();
      const error = await database.db
        .transaction((tx) => insertRecord(tx, invite, inviteValues(), ctx()))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(SecurityTableWriteError);
      expect((error as Error).message).toContain('invite');
      expect(await untouched()).toEqual(before);
    });

    it('refuses to insert an invite_role, which has no id or version column at all', async () => {
      const before = await untouched();
      // The type already says no (it has no `id`), so it is cast to reach the
      // run-time check, which is what a caller that gets past the type meets.
      await expect(
        database.db.transaction((tx) =>
          insertRecord(
            tx,
            inviteRole as never,
            { organisationId, inviteId: newId(), roleId } as never,
            ctx(),
          ),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      expect(await untouched()).toEqual(before);
    });

    it('refuses an update, a delete and a restore of an invite, and writes nothing', async () => {
      // A row the way the auth service makes one: directly.
      const [row] = await database.db
        .insert(invite)
        .values({
          ...inviteValues(),
          originServer: ORIGIN,
          expiresAt: new Date(Date.UTC(2099, 0, 1)),
        })
        .returning();
      const before = await untouched();
      await expect(
        database.db.transaction((tx) =>
          updateRecord(tx, invite, row!.id, 1, { tier: 'guest' }, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          softDeleteRecord(tx, invite, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          restoreRecord(tx, invite, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      expect(await untouched()).toEqual(before);
      const [after] = await database.db.select().from(invite);
      expect(after).toMatchObject({ id: row!.id, tier: 'member', version: 1 });
      expect(after!.deletedAt).toBeNull();
    });

    it('refuses an access_reset too, which carries an organisation_id and a composite key to a membership, and writes nothing', async () => {
      const creator = await seedUser(database);
      const person = await seedUser(database);
      await grantOnOrganisation(database, organisationId, person, 'member', []);
      const values = {
        organisationId,
        userId: person,
        tokenHash: `write-helper-reset-${newId()}`,
        expiresAt: new Date(Date.UTC(2099, 0, 1)),
      };
      // A row the way the auth service makes one: directly.
      const [row] = await database.db
        .insert(accessReset)
        .values({ ...values, originServer: ORIGIN, createdBy: creator })
        .returning();
      const before = await untouched();
      const refused = await database.db
        .transaction((tx) =>
          insertRecord(
            tx,
            accessReset,
            { ...values, tokenHash: `write-helper-reset-${newId()}` },
            ctx(),
          ),
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(refused).toBeInstanceOf(SecurityTableWriteError);
      expect((refused as Error).message).toContain('access_reset');
      expect((refused as Error).message).not.toContain(values.tokenHash);
      await expect(
        database.db.transaction((tx) =>
          updateRecord(
            tx,
            accessReset,
            row!.id,
            1,
            { removePasskeys: true },
            ctx(),
          ),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          softDeleteRecord(tx, accessReset, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          restoreRecord(tx, accessReset, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      expect(await untouched()).toEqual(before);
      const found = (await database.db.select().from(accessReset)).find(
        (candidate) => candidate.id === row!.id,
      );
      expect(found).toMatchObject({ version: 1, removePasskeys: false });
      expect(found!.deletedAt).toBeNull();
    });

    it('refuses an api_token too, which carries an organisation_id and composite keys to a membership and a project, and writes nothing', async () => {
      const owner = await seedUser(database);
      await grantOnOrganisation(database, organisationId, owner, 'member', []);
      const values = {
        organisationId,
        userId: owner,
        name: 'Call sheet export',
        prefix: `osfpm_pat_wh${newId().slice(0, 8)}`,
        tokenHash: `write-helper-token-${newId()}`,
        access: 'read' as const,
      };
      // A row the way the auth service makes one: directly.
      const [row] = await database.db
        .insert(apiToken)
        .values({ ...values, originServer: ORIGIN, createdBy: owner })
        .returning();
      const before = await untouched();
      const refused = await database.db
        .transaction((tx) =>
          insertRecord(
            tx,
            apiToken,
            {
              ...values,
              prefix: `osfpm_pat_wi${newId().slice(0, 8)}`,
              tokenHash: `write-helper-token-${newId()}`,
            },
            ctx(),
          ),
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(refused).toBeInstanceOf(SecurityTableWriteError);
      expect((refused as Error).message).toContain('api_token');
      expect((refused as Error).message).not.toContain(values.tokenHash);
      await expect(
        database.db.transaction((tx) =>
          updateRecord(tx, apiToken, row!.id, 1, { access: 'write' }, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          softDeleteRecord(tx, apiToken, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      await expect(
        database.db.transaction((tx) =>
          restoreRecord(tx, apiToken, row!.id, 1, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
      expect(await untouched()).toEqual(before);
      const found = (await database.db.select().from(apiToken)).find(
        (candidate) => candidate.id === row!.id,
      );
      expect(found).toMatchObject({ version: 1, access: 'read' });
      expect(found!.deletedAt).toBeNull();
    });

    it('refuses a security table without an organisation_id too', async () => {
      await expect(
        database.db.transaction((tx) =>
          insertRecord(tx, session as never, {}, ctx()),
        ),
      ).rejects.toBeInstanceOf(SecurityTableWriteError);
    });

    it('says which table and nothing about the row: no value, no id', async () => {
      const values = inviteValues();
      const error = (await database.db
        .transaction((tx) => insertRecord(tx, invite, values, ctx()))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        )) as Error;
      expect(error.message).not.toContain(values.tokenHash);
      expect(error.message).not.toContain(organisationId);
    });

    it('still writes the helper’s own tables: a role is written and logged as before', async () => {
      const userId = await seedUser(database);
      const before = await untouched();
      await database.db.transaction((tx) =>
        insertRecord(
          tx,
          role,
          {
            organisationId,
            ownerOrgId: organisationId,
            projectId: null,
            key: 'still-written',
            name: 'Still written',
          },
          {
            actor: { type: 'user', id: userId },
            originServer: ORIGIN,
            clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
          },
        ),
      );
      expect((await untouched()).events).toBe(before.events + 1);
    });
  },
);
