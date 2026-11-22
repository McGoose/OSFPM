import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  installation,
  loginChallenge,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  setupCode,
  totpCredential,
} from '../db/schema/index.js';
import { sensitiveColumns } from '../db/sensitive.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { hashPassword } from './password.js';
import { everyRowAsText, rowsOf, seedActiveUser } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const unique = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});
const check = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const foreignKey = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});

let counter = 0;
const next = () => (counter += 1);

describe.each(testTargets)('login tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let userId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    userId = await seedActiveUser(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const origin = newId();

  const sessionValues = (
    overrides: Partial<typeof session.$inferInsert> = {},
  ) => ({
    originServer: origin,
    userId,
    tokenHash: `session-hash-${next()}`,
    method: 'password' as const,
    lastSeenAt: T0,
    idleExpiresAt: at(12 * HOUR),
    absoluteExpiresAt: at(30 * 24 * HOUR),
    ...overrides,
  });

  const defaultOf = async (table: string) => {
    const [row] = await rowsOf(
      database,
      sql`select column_default from information_schema.columns
          where table_schema = 'public' and table_name = ${table}
            and column_name = 'retention_class'`,
    );
    return row!.column_default;
  };

  describe('session', () => {
    it('accepts each method on the list and a row whose idle end equals its absolute end', async () => {
      for (const method of [
        'passkey',
        'password',
        'password+totp',
        'recovery',
        'setup',
        'invite',
      ] as const) {
        await db()
          .insert(session)
          .values(sessionValues({ method, idleExpiresAt: at(30 * 24 * HOUR) }));
      }
    });

    it('rejects an unknown method', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(session)
          .values(sessionValues({ method: 'magic-link' as never })),
      );
      expect(failure).toEqual(check('session_method_check'));
    });

    it('rejects an idle end after the absolute end', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(session)
          .values(
            sessionValues({
              idleExpiresAt: at(30 * 24 * HOUR + 1),
              absoluteExpiresAt: at(30 * 24 * HOUR),
            }),
          ),
      );
      expect(failure).toEqual(check('session_expiry_order_check'));
    });

    it('rejects moving an existing session’s idle end past its absolute end', async () => {
      const [row] = await db()
        .insert(session)
        .values(sessionValues())
        .returning({ id: session.id });
      const failure = await failureOf(() =>
        db()
          .update(session)
          .set({ idleExpiresAt: at(31 * 24 * HOUR) })
          .where(eq(session.id, row!.id)),
      );
      expect(failure).toEqual(check('session_expiry_order_check'));
    });

    it('rejects a second session with the same token hash', async () => {
      const tokenHash = `duplicate-${next()}`;
      await db().insert(session).values(sessionValues({ tokenHash }));
      const failure = await failureOf(() =>
        db().insert(session).values(sessionValues({ tokenHash })),
      );
      expect(failure).toEqual(unique('session_token_hash_unique'));
    });

    it('rejects an unknown user', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(session)
          .values(sessionValues({ userId: newId() })),
      );
      expect(failure).toEqual(foreignKey('session_user_fk'));
    });

    it('allows several sessions for one user, and defaults to the transient class', async () => {
      await db().insert(session).values(sessionValues());
      await db().insert(session).values(sessionValues());
      expect(await defaultOf('session')).toBe("'transient'::text");
    });

    it('defaults the scope to full, accepts recovery, and rejects any other scope', async () => {
      const [plain] = await db()
        .insert(session)
        .values(sessionValues())
        .returning({ scope: session.scope });
      expect(plain!.scope).toBe('full');
      const [limited] = await db()
        .insert(session)
        .values(sessionValues({ scope: 'recovery' }))
        .returning({ scope: session.scope });
      expect(limited!.scope).toBe('recovery');
      const failure = await failureOf(() =>
        db()
          .insert(session)
          .values(sessionValues({ scope: 'admin' as never })),
      );
      expect(failure).toEqual(check('session_scope_check'));
    });

    describe('passkey_credential_id', () => {
      const passkeyOf = async (owner: string) => {
        const [row] = await db()
          .insert(passkeyCredential)
          .values({
            originServer: origin,
            userId: owner,
            credentialId: `session-credential-${next()}`,
            publicKey: Buffer.from([0x04]),
          })
          .returning({ id: passkeyCredential.id });
        return row!.id;
      };

      it('is NULL unless set, and is accepted on a passkey session', async () => {
        const [plain] = await db()
          .insert(session)
          .values(sessionValues())
          .returning();
        expect(plain!.passkeyCredentialId).toBeNull();
        const passkeyCredentialId = await passkeyOf(userId);
        const [tied] = await db()
          .insert(session)
          .values(sessionValues({ method: 'passkey', passkeyCredentialId }))
          .returning();
        expect(tied!.passkeyCredentialId).toBe(passkeyCredentialId);
      });

      it('is refused on a session of any other method', async () => {
        const passkeyCredentialId = await passkeyOf(userId);
        for (const method of [
          'password',
          'password+totp',
          'recovery',
          'setup',
          'invite',
        ] as const) {
          const failure = await failureOf(() =>
            db()
              .insert(session)
              .values(sessionValues({ method, passkeyCredentialId })),
          );
          expect(failure).toEqual(check('session_passkey_credential_check'));
        }
      });

      it('must name a passkey that exists', async () => {
        const failure = await failureOf(() =>
          db()
            .insert(session)
            .values(
              sessionValues({
                method: 'passkey',
                passkeyCredentialId: newId(),
              }),
            ),
        );
        expect(failure).toEqual(foreignKey('session_passkey_credential_fk'));
      });
    });
  });

  describe('login_challenge', () => {
    const challengeValues = (
      overrides: Partial<typeof loginChallenge.$inferInsert> = {},
    ) => ({
      originServer: origin,
      userId,
      kind: 'totp' as const,
      tokenHash: `challenge-hash-${next()}`,
      expiresAt: at(5 * 60 * 1000),
      ...overrides,
    });

    it('starts with no attempts and no used time, and defaults to the transient class', async () => {
      const [row] = await db()
        .insert(loginChallenge)
        .values(challengeValues())
        .returning();
      expect(row!.attempts).toBe(0);
      expect(row!.usedAt).toBeNull();
      expect(await defaultOf('login_challenge')).toBe("'transient'::text");
    });

    it('rejects a kind that is not on the list', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(loginChallenge)
          .values(challengeValues({ kind: 'sms' as never })),
      );
      expect(failure).toEqual(check('login_challenge_kind_check'));
    });

    it('accepts every kind on the list, and no user only for a passkey sign-in', async () => {
      for (const kind of ['totp', 'webauthn-register'] as const) {
        await db().insert(loginChallenge).values(challengeValues({ kind }));
      }
      // A passkey sign-in is not tied to a user until the credential is known.
      await db()
        .insert(loginChallenge)
        .values(challengeValues({ kind: 'webauthn-login', userId: null }));
      // ... and may be, which the rule does not forbid.
      await db()
        .insert(loginChallenge)
        .values(challengeValues({ kind: 'webauthn-login' }));
    });

    it('rejects a challenge with no user unless it is a passkey sign-in', async () => {
      for (const kind of ['totp', 'webauthn-register'] as const) {
        const failure = await failureOf(() =>
          db()
            .insert(loginChallenge)
            .values(challengeValues({ kind, userId: null })),
        );
        expect(failure).toEqual(check('login_challenge_user_check'));
      }
    });

    it('rejects removing the user from a challenge that needs one', async () => {
      const [row] = await db()
        .insert(loginChallenge)
        .values(challengeValues({ kind: 'webauthn-register' }))
        .returning({ id: loginChallenge.id });
      const failure = await failureOf(() =>
        db()
          .update(loginChallenge)
          .set({ userId: null })
          .where(eq(loginChallenge.id, row!.id)),
      );
      expect(failure).toEqual(check('login_challenge_user_check'));
    });

    it('rejects a negative attempt count', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(loginChallenge)
          .values(challengeValues({ attempts: -1 })),
      );
      expect(failure).toEqual(check('login_challenge_attempts_check'));
    });

    it('rejects a duplicate token hash, also across users', async () => {
      const tokenHash = `challenge-duplicate-${next()}`;
      await db().insert(loginChallenge).values(challengeValues({ tokenHash }));
      const other = await seedActiveUser(database);
      const failure = await failureOf(() =>
        db()
          .insert(loginChallenge)
          .values(challengeValues({ tokenHash, userId: other })),
      );
      expect(failure).toEqual(unique('login_challenge_token_hash_unique'));
    });

    it('rejects an unknown user, and allows several challenges for one user', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(loginChallenge)
          .values(challengeValues({ userId: newId() })),
      );
      expect(failure).toEqual(foreignKey('login_challenge_user_fk'));
      await db().insert(loginChallenge).values(challengeValues());
      await db().insert(loginChallenge).values(challengeValues());
    });
  });

  describe('setup_code', () => {
    const codeValues = (
      overrides: Partial<typeof setupCode.$inferInsert> = {},
    ) => ({
      originServer: origin,
      codeHash: `setup-hash-${next()}`,
      expiresAt: at(24 * HOUR),
      ...overrides,
    });

    it('rejects two live codes, whatever their hashes', async () => {
      await db().delete(setupCode);
      await db().insert(setupCode).values(codeValues());
      const failure = await failureOf(() =>
        db().insert(setupCode).values(codeValues()),
      );
      expect(failure).toEqual(unique('setup_code_single_live'));
    });

    it('rejects two live codes even when one has expired, as it is still unused and unrevoked', async () => {
      await db().delete(setupCode);
      await db()
        .insert(setupCode)
        .values(codeValues({ expiresAt: at(-HOUR) }));
      const failure = await failureOf(() =>
        db().insert(setupCode).values(codeValues()),
      );
      expect(failure).toEqual(unique('setup_code_single_live'));
    });

    it('allows any number of used or revoked codes next to one live code', async () => {
      await db().delete(setupCode);
      await db()
        .insert(setupCode)
        .values([
          codeValues({ usedAt: at(HOUR) }),
          codeValues({ usedAt: at(2 * HOUR) }),
          codeValues({ revokedAt: at(HOUR) }),
          codeValues({ revokedAt: at(2 * HOUR) }),
          codeValues({ usedAt: at(HOUR), revokedAt: at(2 * HOUR) }),
          codeValues(),
        ]);
      expect(await db().select().from(setupCode)).toHaveLength(6);
    });

    it('rejects reviving a used code while another is live', async () => {
      await db().delete(setupCode);
      const [used] = await db()
        .insert(setupCode)
        .values(codeValues({ usedAt: at(HOUR) }))
        .returning({ id: setupCode.id });
      await db().insert(setupCode).values(codeValues());
      const failure = await failureOf(() =>
        db()
          .update(setupCode)
          .set({ usedAt: null })
          .where(eq(setupCode.id, used!.id)),
      );
      expect(failure).toEqual(unique('setup_code_single_live'));
    });

    it('defaults to the transient class', async () => {
      expect(await defaultOf('setup_code')).toBe("'transient'::text");
    });
  });

  describe('recovery_code', () => {
    const codeValues = (
      overrides: Partial<typeof recoveryCode.$inferInsert> = {},
    ) => ({
      originServer: origin,
      userId,
      codeHash: `recovery-hash-${next()}`,
      ...overrides,
    });

    it('rejects a duplicate code hash, also across users', async () => {
      const other = await seedActiveUser(database);
      const codeHash = `recovery-duplicate-${next()}`;
      await db().insert(recoveryCode).values(codeValues({ codeHash }));
      for (const owner of [userId, other]) {
        const failure = await failureOf(() =>
          db()
            .insert(recoveryCode)
            .values(codeValues({ codeHash, userId: owner })),
        );
        expect(failure).toEqual(unique('recovery_code_code_hash_unique'));
      }
    });

    it('rejects an unknown user, and allows many codes for one user', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(recoveryCode)
          .values(codeValues({ userId: newId() })),
      );
      expect(failure).toEqual(foreignKey('recovery_code_user_fk'));
      await db()
        .insert(recoveryCode)
        .values([codeValues(), codeValues(), codeValues()]);
    });

    it('has no used time until it is used, and the default class', async () => {
      const [row] = await db()
        .insert(recoveryCode)
        .values(codeValues())
        .returning();
      expect(row!.usedAt).toBeNull();
      expect(await defaultOf('recovery_code')).toBe("'standard'::text");
    });
  });

  describe('password_credential', () => {
    const credentialValues = (
      forUser: string,
      overrides: Partial<typeof passwordCredential.$inferInsert> = {},
    ) => ({
      originServer: origin,
      userId: forUser,
      hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA',
      changedAt: T0,
      ...overrides,
    });

    it('allows one password per user, and defaults must_change to false', async () => {
      const owner = await seedActiveUser(database);
      const [row] = await db()
        .insert(passwordCredential)
        .values(credentialValues(owner))
        .returning();
      expect(row!.mustChange).toBe(false);
      const failure = await failureOf(() =>
        db().insert(passwordCredential).values(credentialValues(owner)),
      );
      expect(failure).toEqual(unique('password_credential_user_unique'));
    });

    it('rejects an unknown user', async () => {
      const failure = await failureOf(() =>
        db().insert(passwordCredential).values(credentialValues(newId())),
      );
      expect(failure).toEqual(foreignKey('password_credential_user_fk'));
    });

    it('keeps no raw password in any table when the hash is stored', async () => {
      const password = 'correct-horse-battery-harbour';
      const owner = await seedActiveUser(database);
      await db()
        .insert(passwordCredential)
        .values(
          credentialValues(owner, { hash: await hashPassword(password) }),
        );
      expect(await everyRowAsText(database)).not.toContain(password);
    });
  });

  describe('totp_credential', () => {
    const credentialValues = (
      forUser: string,
      overrides: Partial<typeof totpCredential.$inferInsert> = {},
    ) => ({
      originServer: origin,
      userId: forUser,
      secret: 'JBSWY3DPEHPK3PXP',
      ...overrides,
    });

    it('allows one secret per user, unconfirmed and unused to start with', async () => {
      const owner = await seedActiveUser(database);
      const [row] = await db()
        .insert(totpCredential)
        .values(credentialValues(owner))
        .returning();
      expect(row!.confirmedAt).toBeNull();
      expect(row!.lastUsedStep).toBeNull();
      const failure = await failureOf(() =>
        db().insert(totpCredential).values(credentialValues(owner)),
      );
      expect(failure).toEqual(unique('totp_credential_user_unique'));
    });

    it('rejects an unknown user', async () => {
      const failure = await failureOf(() =>
        db().insert(totpCredential).values(credentialValues(newId())),
      );
      expect(failure).toEqual(foreignKey('totp_credential_user_fk'));
    });

    it('stores a time step beyond 32 bits', async () => {
      const owner = await seedActiveUser(database);
      const lastUsedStep = 2 ** 40;
      const [row] = await db()
        .insert(totpCredential)
        .values(credentialValues(owner, { lastUsedStep }))
        .returning();
      expect(row!.lastUsedStep).toBe(lastUsedStep);
    });

    it('marks the secret sensitive, and nothing else', () => {
      expect([...sensitiveColumns(totpCredential)]).toEqual(['secret']);
    });
  });

  describe('passkey_credential', () => {
    const credentialValues = (
      overrides: Partial<typeof passkeyCredential.$inferInsert> = {},
    ) => ({
      originServer: origin,
      userId,
      credentialId: `credential-${next()}`,
      publicKey: Buffer.from([0x04, 0x01, 0xff, 0x00]),
      ...overrides,
    });

    it('rejects a duplicate credential id, also for another user', async () => {
      const other = await seedActiveUser(database);
      const credentialId = `credential-duplicate-${next()}`;
      await db()
        .insert(passkeyCredential)
        .values(credentialValues({ credentialId }));
      for (const owner of [userId, other]) {
        const failure = await failureOf(() =>
          db()
            .insert(passkeyCredential)
            .values(credentialValues({ credentialId, userId: owner })),
        );
        expect(failure).toEqual(
          unique('passkey_credential_credential_id_unique'),
        );
      }
    });

    it('rejects an unknown user, and allows several passkeys for one user', async () => {
      const failure = await failureOf(() =>
        db()
          .insert(passkeyCredential)
          .values(credentialValues({ userId: newId() })),
      );
      expect(failure).toEqual(foreignKey('passkey_credential_user_fk'));
      await db()
        .insert(passkeyCredential)
        .values([credentialValues(), credentialValues()]);
    });

    it('defaults the sign count to 0 and the transports to none, and returns the key as bytes', async () => {
      const [row] = await db()
        .insert(passkeyCredential)
        .values(credentialValues())
        .returning();
      expect(row!.signCount).toBe(0);
      expect(row!.transports).toEqual([]);
      expect(row!.deviceName).toBeNull();
      expect(row!.lastUsedAt).toBeNull();
      expect(row!.revokedAt).toBeNull();
      expect(Buffer.isBuffer(row!.publicKey)).toBe(true);
      expect([...row!.publicKey]).toEqual([0x04, 0x01, 0xff, 0x00]);
    });

    it('stores transports and a sign count beyond 32 bits', async () => {
      const [row] = await db()
        .insert(passkeyCredential)
        .values(
          credentialValues({
            transports: ['internal', 'hybrid'],
            signCount: 2 ** 33,
          }),
        )
        .returning();
      expect(row!.transports).toEqual(['internal', 'hybrid']);
      expect(row!.signCount).toBe(2 ** 33);
    });
  });

  describe('installation.setup_completed_at', () => {
    it('is NULL until set', async () => {
      const fresh = await createMigratedDatabase(target);
      try {
        await fresh.database.db
          .insert(installation)
          .values({ id: newId(), baseUrl: 'https://osfpm.example.test' });
        const [row] = await fresh.database.db.select().from(installation);
        expect(row!.setupCompletedAt).toBeNull();
      } finally {
        await fresh.cleanup();
      }
    });
  });
});
