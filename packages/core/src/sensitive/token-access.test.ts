import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setApiTokenSwitches } from '../auth/api-tokens.js';
import { seedTokenScene, type TokenScene } from '../auth/test-support.js';
import {
  engagePerson,
  grantOnProject,
  ORIGIN,
  seedPerson,
  seedUser,
} from '../access/test-fixtures.js';
import type { TokenCredential } from '../access/credential.js';
import type { Database } from '../db/client.js';
import { auditEvent, changeEvent, settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessGrant } from './access-grants.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import {
  complianceReport,
  ComplianceReportDeniedError,
  readSensitive,
  SensitiveAccessDeniedError,
  writeSensitive,
  type SensitiveContext,
} from './service.js';

/**
 * Crew personal data through a personal API token (SC-10, decisions D-17 and D-68;
 * CLAUDE.md, Privacy rule). A token reaches it only through its explicit sensitive
 * scope, with the organisation's sensitive switch on, and only if its owner holds the
 * permission on a project the person is engaged on, at that moment. Every read and every
 * refusal through a token is audited with the token's id. A token never takes the
 * person's own way in: a crew member who wants their own data signs in.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
let clock = 0;
const next = () => new Date(T0.getTime() + (clock += 1) * MINUTE);

describe.each(testTargets)(
  'sensitive data through a token on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: TokenScene;
    /** Holds the medical read and edit permissions on `scene.projectId`. */
    let writerId: string;
    /** The person whose data is read: engaged on `scene.projectId`. */
    let personId: string;
    /** A person who is the owner of an account without any sensitive permission. */
    let ownDataId: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedTokenScene(database, T0);
      writerId = await seedUser(database);
      const { roleId } = await grantOnProject(
        database,
        scene.organisationId,
        scene.projectId,
        writerId,
        [
          'sensitive:edit:medical',
          'sensitive:read:medical',
          'compliance:report',
        ],
      );
      personId = await seedPerson(database, scene.organisationId);
      await engagePerson(
        database,
        scene.organisationId,
        scene.projectId,
        personId,
      );
      // A token that can only read passes the read permission, not the edit one that
      // lets its owner read the whole record of a person without an account. So it reads
      // medical data only through a grant to a role its owner holds, as everyone who only
      // reads does (decision D-69): the person agreed to share all of it with that role.
      await createAccessGrant(database.db, ctx(writerId), {
        projectId: scene.projectId,
        personId,
        category: 'medical',
        roleId,
        fields: ['conditions', 'medication', 'notes'],
        consent: { method: 'phone', at: new Date(T0.getTime() - MINUTE) },
      });
      // The writer puts the person's data in, as a session.
      await writeSensitive(
        database.db,
        ctx(writerId),
        personId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'consent' },
      );
      // The medical member holds the read permission on the project too.
      ownDataId = await seedPerson(database, scene.organisationId, {
        userId: scene.tokensId,
      });
      await engagePerson(
        database,
        scene.organisationId,
        scene.projectId,
        ownDataId,
      );
      await writeSensitive(
        database.db,
        ctx(writerId),
        ownDataId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'consent' },
      );
      await database.db.transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens: true, sensitive: true },
          next(),
        ),
      );
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const ctx = (
      userId: string,
      credential?: TokenCredential,
    ): SensitiveContext => ({
      userId,
      originServer: ORIGIN,
      clock: () => T0,
      ...(credential === undefined ? {} : { credential }),
    });
    const token = (
      overrides: Partial<TokenCredential> = {},
    ): TokenCredential => ({
      kind: 'token',
      tokenId: '0199a3c4-0000-7000-8000-0000000000bb',
      organisationId: scene.organisationId,
      projectId: null,
      access: 'read',
      sensitivePermissions: ['sensitive:read:medical'],
      ...overrides,
    });
    const eventsOf = async (targetId: string, category: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.targetId === targetId && event.category === category,
      );
    const errorOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );

    afterEach(async () => {
      // Back to the switches the tests start from.
      await db().delete(settingValue);
      await db().transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens: true, sensitive: true },
          next(),
        ),
      );
    });

    it('reads through a token that has the scope, and audits the read with the token’s id', async () => {
      const before = (await eventsOf(personId, 'sensitive.read')).length;
      // The writer holds the permission on the project, and is the token's owner.
      const read = await readSensitive(
        db(),
        ctx(writerId, token()),
        personId,
        'medical',
      );
      expect(read?.payload).toEqual(VALID_PAYLOADS.medical);
      const events = (await eventsOf(personId, 'sensitive.read')).slice(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'read',
        actorType: 'token',
        actorId: token().tokenId,
        targetType: 'person',
        organisationId: scene.organisationId,
        details: {
          category: 'medical',
          tokenId: token().tokenId,
          userId: writerId,
        },
      });
      // A session's read is as it was: the user, and the category alone.
      const sessionRead = await readSensitive(
        db(),
        ctx(writerId),
        personId,
        'medical',
      );
      expect(sessionRead).not.toBeNull();
      const last = (await eventsOf(personId, 'sensitive.read')).slice(
        before + 1,
      );
      expect(last).toHaveLength(1);
      expect(last[0]).toMatchObject({
        actorType: 'user',
        actorId: writerId,
        details: { category: 'medical', fieldCount: 3 },
      });
      // The category and the number of fields, never their names.
      expect(Object.keys(last[0]!.details!).sort()).toEqual([
        'category',
        'fieldCount',
      ]);
    });

    it('refuses a token without the scope, though the owner holds the permission, and audits the refusal with the token’s id', async () => {
      const before = (await eventsOf(personId, 'sensitive.denied')).length;
      const refused = await errorOf(
        readSensitive(
          db(),
          ctx(writerId, token({ sensitivePermissions: [] })),
          personId,
          'medical',
        ),
      );
      expect(refused).toBeInstanceOf(SensitiveAccessDeniedError);
      const events = (await eventsOf(personId, 'sensitive.denied')).slice(
        before,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'read',
        actorType: 'token',
        actorId: token().tokenId,
        details: {
          category: 'medical',
          tokenId: token().tokenId,
          userId: writerId,
        },
      });
      // No data was returned or read: no `sensitive.read` came with it.
      expect(
        (await eventsOf(personId, 'sensitive.read')).length,
      ).toBeGreaterThan(0);
    });

    it('refuses a token whose scope lists another key, or whose organisation turned the sensitive switch off', async () => {
      await expect(
        readSensitive(
          db(),
          ctx(
            writerId,
            token({ sensitivePermissions: ['sensitive:read:dietary'] }),
          ),
          personId,
          'medical',
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await db().transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens: true, sensitive: false },
          next(),
        ),
      );
      await expect(
        readSensitive(db(), ctx(writerId, token()), personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('refuses a token for another project, another organisation, or an owner who does not hold the permission', async () => {
      // The person is engaged on `projectId` only.
      await expect(
        readSensitive(
          db(),
          ctx(writerId, token({ projectId: scene.otherProjectId })),
          personId,
          'medical',
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        readSensitive(
          db(),
          ctx(writerId, token({ organisationId: scene.otherOrganisationId })),
          personId,
          'medical',
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      // The token's own project reaches it.
      expect(
        await readSensitive(
          db(),
          ctx(writerId, token({ projectId: scene.projectId })),
          personId,
          'medical',
        ),
      ).not.toBeNull();
      // An owner who holds nothing on the project gets nothing from a token with the scope.
      await expect(
        readSensitive(db(), ctx(scene.tokensId, token()), personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('does not take the person’s own way in: a token reads nobody’s data as its owner’s own', async () => {
      // The owner of this account is the person in the record: a session reads it.
      expect(
        await readSensitive(db(), ctx(scene.tokensId), ownDataId, 'medical'),
      ).not.toBeNull();
      // A token does not, with the scope or without it: the owner holds no permission.
      for (const sensitivePermissions of [[], ['sensitive:read:medical']]) {
        await expect(
          readSensitive(
            db(),
            ctx(scene.tokensId, token({ sensitivePermissions })),
            ownDataId,
            'medical',
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });

    it('lets a read token read and never write, and a write token with the scope write, as a token', async () => {
      const payload = VALID_PAYLOADS.medical;
      const writing = (credential: TokenCredential) =>
        writeSensitive(
          db(),
          ctx(writerId, credential),
          personId,
          'medical',
          payload,
          {
            legalBasis: 'consent',
          },
        );
      // Reads fine as a read token with the read scope; the edit permission is write.
      const reader = token({
        access: 'read',
        sensitivePermissions: ['sensitive:edit:medical'],
      });
      await expect(writing(reader)).rejects.toBeInstanceOf(
        SensitiveAccessDeniedError,
      );
      // A token without the edit key in its scope may not either.
      const noKey = token({
        access: 'write',
        sensitivePermissions: ['sensitive:read:medical'],
      });
      await expect(writing(noKey)).rejects.toBeInstanceOf(
        SensitiveAccessDeniedError,
      );
      // A write token with the edit key writes. The change event says a token did it.
      const writer = token({
        access: 'write',
        sensitivePermissions: ['sensitive:edit:medical'],
      });
      const changed = { ...payload, notes: 'Carries it, and a spare inhaler' };
      const result = await writeSensitive(
        db(),
        ctx(writerId, writer),
        personId,
        'medical',
        changed,
        { legalBasis: 'consent' },
      );
      expect(result.enteredBy).toBe(writerId);
      const events = (await db().select().from(changeEvent)).filter(
        (event) =>
          event.entityType === 'person_sensitive' &&
          event.entityId === result.id,
      );
      const latest = events.sort(
        (a, b) => b.entityVersion - a.entityVersion,
      )[0]!;
      expect(latest).toMatchObject({
        actorType: 'token',
        actorId: writer.tokenId,
      });
    });

    it('gives the count-only report to a token of the owner’s project, and audits a refusal with the token’s id', async () => {
      const report = await complianceReport(
        db(),
        ctx(
          writerId,
          token({ projectId: scene.projectId, sensitivePermissions: [] }),
        ),
        scene.projectId,
      );
      expect(report.projectId).toBe(scene.projectId);
      const refused = await errorOf(
        complianceReport(
          db(),
          ctx(
            writerId,
            token({
              projectId: scene.otherProjectId,
              sensitivePermissions: [],
            }),
          ),
          scene.projectId,
        ),
      );
      expect(refused).toBeInstanceOf(ComplianceReportDeniedError);
      const denied = (
        await eventsOf(scene.projectId, 'sensitive.denied')
      ).filter((event) => event.actorType === 'token');
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        actorId: token().tokenId,
        details: {
          report: 'compliance',
          tokenId: token().tokenId,
          userId: writerId,
        },
      });
    });
  },
);
