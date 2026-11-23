import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { Database } from '../db/client.js';
import {
  apiToken,
  auditEvent,
  project,
  settingValue,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import {
  API_TOKEN_LIFETIME,
  API_TOKEN_PREFIX,
  createApiToken,
  listOrganisationApiTokens,
  listOwnApiTokens,
  revokeAnyApiToken,
  revokeApiToken,
  revokeOwnApiToken,
  setApiTokenSwitches,
  type CreateApiTokenInput,
} from './api-tokens.js';
import {
  ApiSensitiveTokensDisabledError,
  ApiTokensDisabledError,
  NotASensitivePermissionError,
  ProjectNotAvailableError,
  TokenExceedsOwnAccessError,
  TokenReadOnlyScopeError,
} from './api-token-errors.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  seedApiToken,
  seedSession,
  seedTokenScene,
  setMemberRolesEnded,
  setMembershipStatus,
  type TokenScene,
} from './test-support.js';
import { hashToken } from './tokens.js';

/**
 * Making, listing and revoking personal API tokens (SC-10, decisions D-17 and D-68):
 * who may, what a token is, what a refusal says, and what is audited.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A time no other test uses, so an audit event can be found by when it happened. */
let clock = 0;
const next = () => at((clock += 1) * MINUTE);

/** A token as the service makes it: `osfpm_pat_` and 43 characters of base64url. */
const TOKEN_SHAPE = /^osfpm_pat_[A-Za-z0-9_-]{43}$/;

describe.each(testTargets)('personal API tokens on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: TokenScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedTokenScene(database, T0);
  });
  afterAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await database.db.delete(apiToken);
    await database.db.delete(settingValue);
  });

  const db = () => database.db;

  /** Turns the organisation's switches, as its owner does. */
  const turn = (personalTokens: boolean, sensitive = false) =>
    db().transaction((tx) =>
      setApiTokenSwitches(
        tx,
        { userId: scene.ownerId },
        scene.organisationId,
        { personalTokens, sensitive },
        next(),
      ),
    );
  /** Makes a token as `userId`, from a session of theirs that is live. */
  const make = async (
    userId: string,
    input: Partial<CreateApiTokenInput> = {},
    now = next(),
    organisationId = scene.organisationId,
  ) => {
    const sessionId = await seedSession(database, userId);
    return db().transaction((tx) =>
      createApiToken(
        tx,
        { userId, sessionId },
        organisationId,
        { name: 'Call sheet export', access: 'read', ...input },
        now,
      ),
    );
  };
  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
  const stored = async () => db().select().from(apiToken);
  const createdEvents = async (now: Date) =>
    (await db().select().from(auditEvent)).filter(
      (event) =>
        event.category === AUTH_AUDIT.apiTokenCreated &&
        event.occurredAt.getTime() === now.getTime(),
    );

  describe('createApiToken', () => {
    it('needs api:tokens, which api:manage does not give, and refuses a stranger, a member without it and a malformed organisation alike', async () => {
      await turn(true);
      for (const [userId, organisationId] of [
        [scene.managerId, scene.organisationId],
        [scene.plainId, scene.organisationId],
        [scene.strangerId, scene.organisationId],
        [scene.tokensId, scene.otherOrganisationId],
        [scene.tokensId, 'not-an-id'],
      ] as const) {
        const now = next();
        const refused = await errorOf(make(userId, {}, now, organisationId));
        expect(refused, `${userId} in ${organisationId}`).toBeInstanceOf(
          AccessDeniedError,
        );
        expect((refused as AccessDeniedError).permission).toBe('api:tokens');
        expect((refused as AccessDeniedError).scope).toBeUndefined();
        expect(await createdEvents(now)).toEqual([]);
      }
      expect(await stored()).toEqual([]);
    });

    it('refuses a member who was removed, though their role still holds the permission', async () => {
      await turn(true);
      await setMembershipStatus(
        database,
        scene.organisationId,
        scene.tokensId,
        'removed',
      );
      try {
        await expect(make(scene.tokensId)).rejects.toBeInstanceOf(
          AccessDeniedError,
        );
      } finally {
        await setMembershipStatus(
          database,
          scene.organisationId,
          scene.tokensId,
          'active',
        );
      }
    });

    it('is made only from a session that is still live: a revoked or ended one, another person’s and one that is not there are refused with nothing written', async () => {
      await turn(true);
      const person = scene.tokensId;
      const sessions: [string, string][] = [
        [
          'revoked',
          await seedSession(database, person, {
            revokedAt: at(-DAY),
            revokedReason: 'access-reset',
          }),
        ],
        [
          'idle time over',
          await seedSession(database, person, { idleExpiresAt: at(-DAY) }),
        ],
        [
          'absolute time over',
          await seedSession(database, person, {
            idleExpiresAt: at(-2 * DAY),
            absoluteExpiresAt: at(-DAY),
          }),
        ],
        ['another person’s', await seedSession(database, scene.medicalId)],
        ['unknown', '00000000-0000-7000-8000-000000000000'],
        ['malformed', 'not-an-id'],
      ];
      for (const [label, sessionId] of sessions) {
        const now = next();
        const refused = await errorOf(
          db().transaction((tx) =>
            createApiToken(
              tx,
              { userId: person, sessionId },
              scene.organisationId,
              { name: 'Call sheet export', access: 'read' },
              now,
            ),
          ),
        );
        expect(refused, label).toBeInstanceOf(AuthStateError);
        expect((refused as AuthStateError).reason, label).toBe('session-ended');
        expect(await createdEvents(now), label).toEqual([]);
      }
      expect(await stored()).toEqual([]);
      // A live session of the person goes through.
      const live = await seedSession(database, person);
      const made = await db().transaction((tx) =>
        createApiToken(
          tx,
          { userId: person, sessionId: live },
          scene.organisationId,
          { name: 'Call sheet export', access: 'read' },
          next(),
        ),
      );
      expect(made.apiToken.userId).toBe(person);
    });

    it('is refused while personal tokens are off, which is how every organisation starts', async () => {
      const now = next();
      const refused = await errorOf(make(scene.tokensId, {}, now));
      expect(refused).toBeInstanceOf(ApiTokensDisabledError);
      expect(await stored()).toEqual([]);
      expect(await createdEvents(now)).toEqual([]);
      // Switched on and off again, it is refused again.
      await turn(true);
      await turn(false);
      expect(await errorOf(make(scene.tokensId))).toBeInstanceOf(
        ApiTokensDisabledError,
      );
    });

    it('makes a token and shows it once: only its hash is stored, and the prefix is the first 8 characters after osfpm_pat_', async () => {
      await turn(true);
      const now = next();
      const made = await make(
        scene.tokensId,
        { name: '  Call sheet export ' },
        now,
      );

      expect(made.token).toMatch(TOKEN_SHAPE);
      expect(made.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
      const rows = await stored();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        id: made.apiToken.id,
        organisationId: scene.organisationId,
        userId: scene.tokensId,
        projectId: null,
        name: 'Call sheet export',
        prefix: made.token.slice(0, API_TOKEN_PREFIX.length + 8),
        // The hash is of the random part, as a session token's is: the fixed start is public.
        tokenHash: hashToken(made.token.slice(API_TOKEN_PREFIX.length)),
        access: 'read',
        sensitivePermissions: [],
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        createdAt: now,
        createdBy: scene.tokensId,
        retentionClass: 'transient',
      });
      expect(row.prefix).toHaveLength(18);
      // Nothing of the token is kept anywhere but the hash and the prefix.
      const everything = await everyRowAsText(database);
      expect(everything).not.toContain(made.token);
      expect(everything).not.toContain(
        made.token.slice(API_TOKEN_PREFIX.length),
      );
      // The view has no hash, and says what the token is.
      expect(made.apiToken).toEqual({
        id: row.id,
        organisationId: scene.organisationId,
        userId: scene.tokensId,
        projectId: null,
        name: 'Call sheet export',
        prefix: row.prefix,
        access: 'read',
        sensitivePermissions: [],
        expiresAt: new Date(now.getTime() + 365 * DAY),
        neverExpires: false,
        createdAt: now,
        lastUsedAt: null,
      });
      expect(JSON.stringify(made.apiToken)).not.toContain(row.tokenHash);
    });

    it('never makes two tokens with the same token, hash or prefix', async () => {
      await turn(true);
      const tokens = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        tokens.add((await make(scene.tokensId)).token);
      }
      expect(tokens.size).toBe(20);
      const rows = await stored();
      expect(new Set(rows.map((row) => row.prefix)).size).toBe(20);
      expect(new Set(rows.map((row) => row.tokenHash)).size).toBe(20);
    });

    describe('expiry', () => {
      it('is 365 days when the request gives none, and the maintainer’s bounds are 1 to 3650', async () => {
        await turn(true);
        expect(API_TOKEN_LIFETIME).toEqual({
          defaultDays: 365,
          minDays: 1,
          maxDays: 3650,
        });
        const now = next();
        const plain = await make(scene.tokensId, {}, now);
        expect(plain.apiToken.expiresAt).toEqual(
          new Date(now.getTime() + 365 * DAY),
        );
        for (const days of [1, 30, 365, 3650]) {
          const when = next();
          const made = await make(
            scene.tokensId,
            { expiresInDays: days },
            when,
          );
          expect(made.apiToken.expiresAt).toEqual(
            new Date(when.getTime() + days * DAY),
          );
          expect(made.apiToken.neverExpires).toBe(false);
        }
      });

      it('refuses a number outside 1 to 3650, a fraction and anything that is not a number', async () => {
        await turn(true);
        for (const expiresInDays of [
          0,
          -1,
          3651,
          1.5,
          Number.NaN,
          '30',
          null,
        ]) {
          const refused = await errorOf(
            make(scene.tokensId, { expiresInDays } as never),
          );
          expect(refused, String(expiresInDays)).toBeInstanceOf(AuthInputError);
          expect((refused as AuthInputError).field).toBe('expiresInDays');
        }
        expect(await stored()).toEqual([]);
      });

      it('never expires when noExpiry is set, and the view and the list say so', async () => {
        await turn(true);
        const made = await make(scene.tokensId, { noExpiry: true });
        expect(made.apiToken).toMatchObject({
          expiresAt: null,
          neverExpires: true,
        });
        expect((await stored())[0]!.expiresAt).toBeNull();
        const listed = await db().transaction((tx) =>
          listOwnApiTokens(
            tx,
            { userId: scene.tokensId },
            scene.organisationId,
            next(),
          ),
        );
        expect(listed[0]).toMatchObject({
          expiresAt: null,
          neverExpires: true,
        });
        // `false` is the same as leaving it out.
        const timed = await make(scene.tokensId, { noExpiry: false });
        expect(timed.apiToken.neverExpires).toBe(false);
      });

      it('refuses noExpiry together with expiresInDays, whatever the number', async () => {
        await turn(true);
        for (const expiresInDays of [1, 365, 3650]) {
          const refused = await errorOf(
            make(scene.tokensId, { noExpiry: true, expiresInDays }),
          );
          expect(refused).toBeInstanceOf(AuthInputError);
          expect((refused as AuthInputError).field).toBe('noExpiry');
        }
        const refused = await errorOf(
          make(scene.tokensId, { noExpiry: 'yes' } as never),
        );
        expect((refused as AuthInputError).field).toBe('noExpiry');
        expect(await stored()).toEqual([]);
      });
    });

    describe('the name and the access', () => {
      it('takes 1 to 100 characters after trimming, with no control character, and refuses the rest', async () => {
        await turn(true);
        for (const name of [
          'x',
          'x'.repeat(100),
          '  padded  ',
          'Ada’s laptop',
        ]) {
          const made = await make(scene.tokensId, { name });
          expect(made.apiToken.name).toBe(name.trim());
        }
        const newline = String.fromCharCode(10);
        const nul = String.fromCharCode(0);
        for (const name of [
          '',
          '   ',
          'x'.repeat(101),
          `two${newline}lines`,
          `nul${nul}`,
          7,
          null,
          undefined,
        ]) {
          const refused = await errorOf(
            make(scene.tokensId, { name } as never),
          );
          expect(refused, String(name)).toBeInstanceOf(AuthInputError);
          expect((refused as AuthInputError).field).toBe('name');
        }
      });

      it('is read or write', async () => {
        await turn(true);
        expect(
          (await make(scene.tokensId, { access: 'read' })).apiToken.access,
        ).toBe('read');
        expect(
          (await make(scene.tokensId, { access: 'write' })).apiToken.access,
        ).toBe('write');
        for (const access of ['admin', 'READ', '', undefined, 1]) {
          const refused = await errorOf(
            make(scene.tokensId, { access } as never),
          );
          expect(refused, String(access)).toBeInstanceOf(AuthInputError);
          expect((refused as AuthInputError).field).toBe('access');
        }
      });
    });

    describe('the project', () => {
      it('may be one the owner reaches through a project membership or through a grant for every project', async () => {
        await turn(true);
        const viaMembership = await make(scene.medicalId, {
          projectId: scene.projectId,
        });
        expect(viaMembership.apiToken.projectId).toBe(scene.projectId);
        // The owner holds ordinary permissions for every project.
        const viaGrant = await make(scene.ownerId, {
          projectId: scene.otherProjectId,
        });
        expect(viaGrant.apiToken.projectId).toBe(scene.otherProjectId);
        expect((await stored()).map((row) => row.projectId).sort()).toEqual(
          [scene.projectId, scene.otherProjectId].sort(),
        );
        // `null` is the whole organisation, as leaving it out is.
        expect(
          (await make(scene.tokensId, { projectId: null })).apiToken.projectId,
        ).toBeNull();
      });

      it('is one refusal, the same for every cause, when it is another organisation’s, unknown, deleted or one the owner cannot reach', async () => {
        await turn(true);
        await db()
          .update(project)
          .set({ deletedAt: new Date() })
          .where(eq(project.id, scene.otherProjectId));
        const messages = new Set<string>();
        try {
          for (const [userId, projectId] of [
            [scene.ownerId, scene.foreignProjectId],
            [scene.ownerId, '00000000-0000-7000-8000-000000000000'],
            [scene.ownerId, scene.otherProjectId],
            // A member with no membership of the project and no grant for all of them.
            [scene.tokensId, scene.projectId],
            // Reaches `projectId` but not the second project.
            [scene.medicalId, scene.otherProjectId],
          ] as const) {
            const refused = await errorOf(make(userId, { projectId }));
            expect(refused, `${userId} ${projectId}`).toBeInstanceOf(
              ProjectNotAvailableError,
            );
            const message = (refused as Error).message;
            expect(message).not.toContain(projectId);
            messages.add(message);
          }
        } finally {
          await db()
            .update(project)
            .set({ deletedAt: null })
            .where(eq(project.id, scene.otherProjectId));
        }
        // One answer: nothing says which of the causes it was.
        expect(messages.size).toBe(1);
        // A value that is not an id is no project at all, and is a bad request as any
        // malformed field is, whatever the person reaches.
        const malformed = await errorOf(
          make(scene.ownerId, { projectId: 'not-an-id' }),
        );
        expect(malformed).toBeInstanceOf(AuthInputError);
        expect((malformed as AuthInputError).field).toBe('projectId');
        expect(await stored()).toEqual([]);
      });
    });

    describe('the sensitive scope', () => {
      it('is refused while the sensitive switch is off, though tokens are on', async () => {
        await turn(true, false);
        const now = next();
        const refused = await errorOf(
          make(
            scene.medicalId,
            { sensitivePermissions: ['sensitive:read:medical'] },
            now,
          ),
        );
        expect(refused).toBeInstanceOf(ApiSensitiveTokensDisabledError);
        expect(await stored()).toEqual([]);
        expect(await createdEvents(now)).toEqual([]);
        // Without a scope the same member makes a token as usual.
        expect(await make(scene.medicalId)).toBeDefined();
      });

      it('is refused for a key that is not a sensitive permission, or is no permission, and names where in the list', async () => {
        await turn(true, true);
        const refused = await errorOf(
          make(scene.ownerId, {
            sensitivePermissions: [
              'sensitive:read:medical',
              'members:read',
              'no-such:permission',
              'costs:read',
              'x'.repeat(80),
            ],
          }),
        );
        expect(refused).toBeInstanceOf(NotASensitivePermissionError);
        expect((refused as NotASensitivePermissionError).indexes).toEqual([
          1, 2, 4,
        ]);
        expect(String((refused as Error).message)).not.toContain(
          'members:read',
        );
        expect(await stored()).toEqual([]);
      });

      it('is refused for a key the owner does not hold in the organisation, and lists the keys', async () => {
        await turn(true, true);
        const refused = await errorOf(
          make(scene.tokensId, {
            sensitivePermissions: [
              'sensitive:read:medical',
              'sensitive:read:dietary',
            ],
          }),
        );
        expect(refused).toBeInstanceOf(TokenExceedsOwnAccessError);
        expect((refused as TokenExceedsOwnAccessError).permissions).toEqual([
          'sensitive:read:dietary',
          'sensitive:read:medical',
        ]);
        // The member who holds one of them still is not given the other.
        const partly = await errorOf(
          make(scene.medicalId, {
            sensitivePermissions: [
              'sensitive:read:medical',
              'sensitive:read:dietary',
            ],
          }),
        );
        expect((partly as TokenExceedsOwnAccessError).permissions).toEqual([
          'sensitive:read:dietary',
        ]);
      });

      it('is held by the owner where the token is: for a project token, on that project', async () => {
        await turn(true, true);
        // Holds the medical read permission on the project through a project role.
        const read = await make(scene.medicalId, {
          projectId: scene.projectId,
          sensitivePermissions: ['sensitive:read:medical'],
        });
        expect(read.apiToken.sensitivePermissions).toEqual([
          'sensitive:read:medical',
        ]);
        // Holds the edit permission in the organisation, not on the project.
        const edit = await errorOf(
          make(scene.medicalId, {
            projectId: scene.projectId,
            access: 'write',
            sensitivePermissions: ['sensitive:edit:medical'],
          }),
        );
        expect(edit).toBeInstanceOf(TokenExceedsOwnAccessError);
        expect((edit as TokenExceedsOwnAccessError).permissions).toEqual([
          'sensitive:edit:medical',
        ]);
        // The owner holds sensitive permissions in the organisation, never on a
        // project without a membership of it.
        const owner = await errorOf(
          make(scene.ownerId, {
            projectId: scene.projectId,
            sensitivePermissions: ['sensitive:read:medical'],
          }),
        );
        expect(owner).toBeInstanceOf(TokenExceedsOwnAccessError);
      });

      it('lets a token for the whole organisation carry what the owner holds there, and keeps each key once', async () => {
        await turn(true, true);
        const made = await make(scene.ownerId, {
          access: 'write',
          sensitivePermissions: [
            'sensitive:edit:medical',
            'sensitive:read:medical',
            'sensitive:edit:medical',
          ],
        });
        expect(made.apiToken.sensitivePermissions).toEqual([
          'sensitive:edit:medical',
          'sensitive:read:medical',
        ]);
        expect((await stored())[0]!.sensitivePermissions).toEqual([
          'sensitive:edit:medical',
          'sensitive:read:medical',
        ]);
      });

      it('lets a read token list read permissions only, and refuses a write permission, naming its place in the list', async () => {
        await turn(true, true);
        expect(
          (
            await make(scene.ownerId, {
              access: 'read',
              sensitivePermissions: ['sensitive:read:medical', 'costs:read'],
            })
          ).apiToken.access,
        ).toBe('read');
        for (const [keys, indexes] of [
          [['sensitive:edit:medical'], [0]],
          // Mixed today, so it counts as write: a read token cannot hold it.
          [['contracts:read-value'], [0]],
          [['sensitive:read:medical', 'sensitive:edit:medical'], [1]],
          [
            ['sensitive:edit:medical', 'costs:read', 'contracts:read-value'],
            [0, 2],
          ],
        ] as const) {
          const refused = await errorOf(
            make(scene.ownerId, {
              access: 'read',
              sensitivePermissions: [...keys],
            }),
          );
          expect(refused, keys.join()).toBeInstanceOf(TokenReadOnlyScopeError);
          // The places, never the keys: a key is what the caller sent.
          expect((refused as TokenReadOnlyScopeError).indexes).toEqual(indexes);
          expect((refused as Error).message).not.toContain(keys[0]);
        }
        // A write token may list them.
        expect(
          (
            await make(scene.ownerId, {
              access: 'write',
              sensitivePermissions: [
                'sensitive:edit:medical',
                'contracts:read-value',
              ],
            })
          ).apiToken.sensitivePermissions,
        ).toHaveLength(2);
      });

      it('takes a list of strings of a sensible size, and nothing else', async () => {
        await turn(true, true);
        for (const sensitivePermissions of [
          'sensitive:read:medical',
          [1],
          [null],
          [{ key: 'sensitive:read:medical' }],
          Array.from({ length: 101 }, () => 'sensitive:read:medical'),
          ['x'.repeat(101)],
        ]) {
          const refused = await errorOf(
            make(scene.ownerId, { sensitivePermissions } as never),
          );
          expect(refused).toBeInstanceOf(AuthInputError);
          expect((refused as AuthInputError).field).toBe(
            'sensitivePermissions',
          );
        }
        // An empty list is no scope at all.
        expect(
          (await make(scene.ownerId, { sensitivePermissions: [] })).apiToken
            .sensitivePermissions,
        ).toEqual([]);
        // Names that every object inherits are not permissions.
        const refused = await errorOf(
          make(scene.ownerId, {
            sensitivePermissions: ['__proto__', 'constructor'],
          }),
        );
        expect(refused).toBeInstanceOf(NotASensitivePermissionError);
      });
    });

    it('audits the creation once, with the owner, the project, the access, the scope, the expiry and the prefix, and nothing that could be used', async () => {
      await turn(true, true);
      const now = next();
      const made = await make(
        scene.medicalId,
        {
          name: 'A name the audit trail does not keep',
          projectId: scene.projectId,
          sensitivePermissions: ['sensitive:read:medical'],
          expiresInDays: 30,
        },
        now,
      );
      const events = await createdEvents(now);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId: scene.organisationId,
        actorType: 'user',
        actorId: scene.medicalId,
        targetType: 'api_token',
        targetId: made.apiToken.id,
        details: {
          userId: scene.medicalId,
          projectId: scene.projectId,
          access: 'read',
          sensitivePermissions: 'sensitive:read:medical',
          expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
          prefix: made.apiToken.prefix,
        },
      });
      const text = JSON.stringify(events);
      expect(text).not.toContain(made.token);
      // The stored hash, read from the table: the audit event must not hold it either.
      for (const row of await stored()) {
        expect(text).not.toContain(row.tokenHash);
      }
      expect(text).not.toContain('A name the audit');
      // A token that never expires says so, and has no project or scope.
      const later = next();
      await make(scene.tokensId, { noExpiry: true }, later);
      expect((await createdEvents(later))[0]!.details).toMatchObject({
        projectId: null,
        sensitivePermissions: '',
        expiresAt: 'never',
      });
    });
  });

  describe('listing', () => {
    it('shows a member their own live tokens, newest first, with no hash', async () => {
      await turn(true, true);
      const first = await make(scene.medicalId, { name: 'First' }, next());
      const second = await make(
        scene.medicalId,
        {
          name: 'Second',
          noExpiry: true,
          sensitivePermissions: ['sensitive:read:medical'],
        },
        next(),
      );
      await make(scene.tokensId, { name: 'Someone else’s' }, next());
      // Not live: revoked, and expired.
      await seedApiToken(database, scene.organisationId, scene.medicalId, {
        name: 'Revoked',
        revokedAt: at(-DAY),
        revokeReason: 'manual',
        revokedBy: scene.medicalId,
      });
      await seedApiToken(database, scene.organisationId, scene.medicalId, {
        name: 'Expired',
        expiresAt: at(-DAY),
      });

      const list = await db().transaction((tx) =>
        listOwnApiTokens(
          tx,
          { userId: scene.medicalId },
          scene.organisationId,
          next(),
        ),
      );
      expect(list.map((view) => view.name)).toEqual(['Second', 'First']);
      expect(list[0]).toMatchObject({
        id: second.apiToken.id,
        sensitivePermissions: ['sensitive:read:medical'],
        neverExpires: true,
        expiresAt: null,
      });
      expect(list[1]).toMatchObject({
        id: first.apiToken.id,
        neverExpires: false,
      });
      expect(JSON.stringify(list)).not.toMatch(/token_?hash|tokenHash/i);
      expect(Object.keys(list[0]!).sort()).toEqual(
        [
          'access',
          'createdAt',
          'expiresAt',
          'id',
          'lastUsedAt',
          'name',
          'neverExpires',
          'organisationId',
          'prefix',
          'projectId',
          'sensitivePermissions',
          'userId',
        ].sort(),
      );
    });

    it('needs no permission for your own: a person who lost api:tokens still lists what they made, and everyone else’s list is empty', async () => {
      await turn(true);
      const left = await make(scene.tokensId, { name: 'Left behind' });
      await make(scene.medicalId, { name: 'Someone else’s' });
      const listOwn = (userId: string, organisationId = scene.organisationId) =>
        db().transaction((tx) =>
          listOwnApiTokens(tx, { userId }, organisationId, next()),
        );
      await setMemberRolesEnded(
        database,
        scene.organisationId,
        scene.tokensId,
        true,
      );
      try {
        const list = await listOwn(scene.tokensId);
        expect(list.map((view) => view.id)).toEqual([left.apiToken.id]);
      } finally {
        await setMemberRolesEnded(
          database,
          scene.organisationId,
          scene.tokensId,
          false,
        );
      }
      // Nobody else sees it, whatever they hold: a member without the permission, a
      // member who manages tokens, a stranger, another organisation and a malformed id
      // all get an empty list, which says nothing about whether anything exists.
      for (const userId of [scene.plainId, scene.managerId, scene.strangerId]) {
        expect(await listOwn(userId), userId).toEqual([]);
      }
      expect(await listOwn(scene.tokensId, scene.otherOrganisationId)).toEqual(
        [],
      );
      expect(await listOwn(scene.tokensId, 'not-an-id')).toEqual([]);
      expect(await listOwn('not-an-id')).toEqual([]);
    });

    it('lets api:manage list every live token of the organisation with its owner, and nobody else', async () => {
      await turn(true, true);
      await make(scene.medicalId, { name: 'Medical’s' }, next());
      await make(scene.tokensId, { name: 'Tokens’', noExpiry: true }, next());
      await seedApiToken(
        database,
        scene.otherOrganisationId,
        scene.strangerId,
        {
          name: 'Other organisation',
        },
      );
      await seedApiToken(database, scene.organisationId, scene.tokensId, {
        name: 'Revoked',
        revokedAt: at(-DAY),
        revokeReason: 'switch-off',
      });
      const list = await db().transaction((tx) =>
        listOrganisationApiTokens(
          tx,
          { userId: scene.managerId },
          scene.organisationId,
          next(),
        ),
      );
      expect(list.map((view) => view.name)).toEqual(['Tokens’', 'Medical’s']);
      expect(list[0]).toMatchObject({
        userId: scene.tokensId,
        ownerDisplayName: expect.stringContaining('Fixture User') as string,
        neverExpires: true,
      });
      expect(JSON.stringify(list)).not.toMatch(/token_?hash|tokenHash/i);
      for (const userId of [scene.tokensId, scene.plainId, scene.strangerId]) {
        await expect(
          db().transaction((tx) =>
            listOrganisationApiTokens(
              tx,
              { userId },
              scene.organisationId,
              next(),
            ),
          ),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });
  });

  describe('revoking', () => {
    const revokeOwn = (userId: string, tokenId: string, now = next()) =>
      db().transaction((tx) =>
        revokeOwnApiToken(tx, { userId }, scene.organisationId, tokenId, now),
      );
    const revokeAny = (userId: string, tokenId: string, now = next()) =>
      db().transaction((tx) =>
        revokeAnyApiToken(tx, { userId }, scene.organisationId, tokenId, now),
      );
    const revokeEvents = async (now: Date) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.apiTokenRevoked &&
          event.occurredAt.getTime() === now.getTime(),
      );

    it('lets the owner revoke their own token, which stops it, audited with the reason and who', async () => {
      await turn(true);
      const made = await make(scene.tokensId);
      const now = next();
      await revokeOwn(scene.tokensId, made.apiToken.id, now);
      expect((await stored())[0]).toMatchObject({
        revokedAt: now,
        revokeReason: 'manual',
        revokedBy: scene.tokensId,
        version: 2,
      });
      const events = await revokeEvents(now);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId: scene.organisationId,
        actorType: 'user',
        actorId: scene.tokensId,
        targetType: 'api_token',
        targetId: made.apiToken.id,
        details: { reason: 'manual', userId: scene.tokensId },
      });
      expect(JSON.stringify(events)).not.toContain(made.token);
      // It is not listed any more.
      expect(
        await db().transaction((tx) =>
          listOwnApiTokens(
            tx,
            { userId: scene.tokensId },
            scene.organisationId,
            next(),
          ),
        ),
      ).toEqual([]);
    });

    it('answers not found, the same way, for a token that is not live, not theirs, not in this organisation or not an id', async () => {
      await turn(true);
      const mine = await make(scene.tokensId);
      const someoneElses = await make(scene.medicalId);
      const expired = await seedApiToken(
        database,
        scene.organisationId,
        scene.tokensId,
        { expiresAt: at(-DAY) },
      );
      const foreign = await seedApiToken(
        database,
        scene.otherOrganisationId,
        scene.strangerId,
      );
      const revokedAlready = await seedApiToken(
        database,
        scene.organisationId,
        scene.tokensId,
        {
          revokedAt: at(-DAY),
          revokeReason: 'manual',
          revokedBy: scene.tokensId,
        },
      );
      for (const tokenId of [
        someoneElses.apiToken.id,
        expired.id,
        foreign.id,
        revokedAlready.id,
        '00000000-0000-7000-8000-000000000000',
        'not-an-id',
      ]) {
        const refused = await errorOf(revokeOwn(scene.tokensId, tokenId));
        expect(refused, tokenId).toBeInstanceOf(RecordNotFoundError);
      }
      // Nothing changed, and the member's own token is still live.
      const rows = new Map((await stored()).map((row) => [row.id, row]));
      expect(rows.get(someoneElses.apiToken.id)!.revokedAt).toBeNull();
      expect(rows.get(mine.apiToken.id)!.revokedAt).toBeNull();
      expect(rows.get(expired.id)!.revokedAt).toBeNull();
      expect(rows.get(foreign.id)!.revokedAt).toBeNull();
    });

    it('revokes once: the second revoke of one token is a not found, and changes nothing', async () => {
      await turn(true);
      const made = await make(scene.tokensId);
      const now = next();
      await revokeOwn(scene.tokensId, made.apiToken.id, now);
      const again = next();
      expect(
        await errorOf(revokeOwn(scene.tokensId, made.apiToken.id, again)),
      ).toBeInstanceOf(RecordNotFoundError);
      expect(
        await errorOf(revokeAny(scene.managerId, made.apiToken.id, again)),
      ).toBeInstanceOf(RecordNotFoundError);
      expect((await stored())[0]).toMatchObject({ revokedAt: now, version: 2 });
      expect(await revokeEvents(again)).toEqual([]);
    });

    it('needs no permission to revoke your own, which only takes access away, and api:manage to revoke anyone’s', async () => {
      await turn(true);
      const made = await make(scene.tokensId);
      // Anyone else’s token is a not found whoever asks, with or without a permission.
      for (const userId of [scene.managerId, scene.plainId, scene.strangerId]) {
        expect(
          await errorOf(revokeOwn(userId, made.apiToken.id)),
        ).toBeInstanceOf(RecordNotFoundError);
      }
      // Holding api:tokens is not enough to revoke someone else's token.
      expect(
        await errorOf(revokeAny(scene.medicalId, made.apiToken.id)),
      ).toBeInstanceOf(AccessDeniedError);
      expect((await stored())[0]!.revokedAt).toBeNull();

      const now = next();
      await revokeAny(scene.managerId, made.apiToken.id, now);
      expect((await stored())[0]).toMatchObject({
        revokedAt: now,
        revokeReason: 'manual',
        revokedBy: scene.managerId,
      });
      expect((await revokeEvents(now))[0]).toMatchObject({
        actorId: scene.managerId,
        details: { reason: 'manual', userId: scene.tokensId },
      });
    });

    it('lets a person who lost api:tokens revoke their own token, which is audited as any revoke is', async () => {
      await turn(true);
      const made = await make(scene.tokensId);
      await setMemberRolesEnded(
        database,
        scene.organisationId,
        scene.tokensId,
        true,
      );
      const now = next();
      try {
        await revokeOwn(scene.tokensId, made.apiToken.id, now);
      } finally {
        await setMemberRolesEnded(
          database,
          scene.organisationId,
          scene.tokensId,
          false,
        );
      }
      expect((await stored())[0]).toMatchObject({
        revokedAt: now,
        revokeReason: 'manual',
        revokedBy: scene.tokensId,
        version: 2,
      });
      expect(await revokeEvents(now)).toHaveLength(1);
    });

    it('is one entry for the route: the owner revokes their own, a manager anyone’s, and anyone else meets a not found', async () => {
      await turn(true);
      const mine = await make(scene.tokensId);
      const medical = await make(scene.medicalId);
      const third = await make(scene.medicalId);
      const revoke = (userId: string, tokenId: string) =>
        db().transaction((tx) =>
          revokeApiToken(tx, { userId }, scene.organisationId, tokenId, next()),
        );
      await revoke(scene.tokensId, mine.apiToken.id);
      // A member with api:tokens only meets a not found for another’s, not a 403.
      expect(
        await errorOf(revoke(scene.tokensId, medical.apiToken.id)),
      ).toBeInstanceOf(RecordNotFoundError);
      await revoke(scene.managerId, medical.apiToken.id);
      await revoke(scene.ownerId, third.apiToken.id);
      // A person with neither permission is no different from one who has api:tokens: the
      // token is not theirs, and that is all the answer says.
      const fresh = await make(scene.medicalId);
      for (const userId of [scene.plainId, scene.strangerId]) {
        expect(await errorOf(revoke(userId, fresh.apiToken.id))).toBeInstanceOf(
          RecordNotFoundError,
        );
      }
      await revoke(scene.ownerId, fresh.apiToken.id);
      expect((await stored()).every((row) => row.revokedAt !== null)).toBe(
        true,
      );
    });
  });
});
