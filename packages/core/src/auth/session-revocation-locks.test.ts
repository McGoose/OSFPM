import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { apiToken, session } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { createApiToken, setApiTokenSwitches } from './api-tokens.js';
import { AuthStateError } from './errors.js';
import { revokePasskey } from './passkeys.js';
import { setPassword } from './password-service.js';
import { generateRecoveryCodes, verifyRecoveryLogin } from './recovery.js';
import { disableUser } from './sessions.js';
import {
  emailOf,
  seedActiveUser,
  seedMembership,
  seedOrganisationRole,
  seedPasskey,
  seedPassword,
  seedSession,
  seedTokenScene,
  seedTotp,
  type TokenScene,
} from './test-support.js';
import { removeTotp } from './totp.js';
import { useTestServerKeys } from '../keys/test-support.js';

/** The server keys of this test file, in a key directory that is deleted afterwards. */
const serverKeys = useTestServerKeys();

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;

/** A time no other call uses, so a row can be told from the ones before it. */
let clock = 0;
const next = () => new Date(T0.getTime() + (clock += 1) * MINUTE);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** An invented password for the people below, and the one a password change sets. */
const PASSWORD = 'meadow-lantern-slow-river';
const NEW_PASSWORD = 'harbour-copper-quiet-orchard';

/** The value of a call that went through. */
const valueOf = <T>(outcome: PromiseSettledResult<unknown>): T => {
  if (outcome.status !== 'fulfilled') {
    throw new Error(
      'The call was refused, and the test expected it to go through',
    );
  }
  return outcome.value as T;
};
/** Why a call was refused, or undefined when it went through. */
const reasonOf = (outcome: PromiseSettledResult<unknown>): unknown =>
  outcome.status === 'rejected' ? outcome.reason : undefined;

/**
 * One person, with the sessions a bulk revocation ends and the one it keeps, and the call
 * that revokes them. `ends` is the session a token is made from in the tests below.
 */
type Revocation = {
  readonly userId: string;
  /** The session the revocation ends, and the token is made from. */
  readonly ends: string;
  /** Runs the revocation, in the transaction it is handed. */
  readonly run: (tx: Tx) => Promise<unknown>;
};

/**
 * Personal API tokens racing the services that end a person's sessions in bulk (CLAUDE.md,
 * Data rules: lock order; SC-10, decision D-68). `createApiToken` holds the person's row
 * `FOR KEY SHARE` and then reads the session it is made from, so a service that ends
 * sessions without holding that row `FOR UPDATE` is not queued behind it, and a token can
 * be made, after the revocation, from a session the revocation ended. Each ordered case
 * holds one transaction open after its work while the other starts, and waits until the
 * second is blocked on a lock (`interleave`), so the two really overlap and the order is
 * the one the test names. They need two real sessions, so they run on PostgreSQL and are
 * skipped on PGlite.
 *
 * The five services are every caller of `revokeUserSessions` and `revokePasskeySessions`
 * but the use of an admin reset link, which holds the row `FOR UPDATE` already and has its
 * own tests (`api-token-race.test.ts`).
 */
describe.skipIf(postgres === undefined)(
  'ending a person’s sessions in bulk against making a personal API token, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: TokenScene;
    let tokenRole: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedTokenScene(database, T0);
      tokenRole = await seedOrganisationRole(
        database,
        scene.organisationId,
        'session-lock-tokens',
        [['api:tokens', 'own-scope']],
      );
      // A new organisation has personal tokens off, and a token made in these cases
      // has to be made, so the owner turns them on, as an administrator would.
      await setApiTokenSwitches(
        database.db,
        { userId: scene.ownerId },
        scene.organisationId,
        { personalTokens: true, sensitive: false },
        next(),
      );
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;

    /** A new member who may make tokens and has a password, so no case changes another's person. */
    async function newMember(): Promise<string> {
      const userId = await seedActiveUser(database);
      await seedMembership(database, scene.organisationId, userId, 'member', [
        tokenRole,
      ]);
      await seedPassword(database, userId, PASSWORD, { now: T0 });
      return userId;
    }

    /** Makes a token as `userId`, from `sessionId`. */
    const make = (tx: Tx, userId: string, sessionId: string) =>
      createApiToken(
        tx,
        { userId, sessionId },
        scene.organisationId,
        { name: 'Call sheet export', access: 'read' },
        next(),
      );

    /** Every token the person has, revoked or not. */
    const tokensOf = (userId: string) =>
      db().select().from(apiToken).where(eq(apiToken.userId, userId));

    /** Whether the session is still live. */
    const live = async (sessionId: string) =>
      (
        await db()
          .select({ revokedAt: session.revokedAt })
          .from(session)
          .where(eq(session.id, sessionId))
      )[0]!.revokedAt === null;

    const cases: readonly {
      readonly name: string;
      readonly prepare: () => Promise<Revocation>;
    }[] = [
      {
        name: 'a password change',
        prepare: async () => {
          const userId = await newMember();
          const keeps = await seedSession(database, userId);
          return {
            userId,
            ends: await seedSession(database, userId),
            run: (tx) =>
              setPassword(tx, {
                userId,
                newPassword: NEW_PASSWORD,
                currentPassword: PASSWORD,
                session: { id: keeps, scope: 'full' },
                now: next(),
              }),
          };
        },
      },
      {
        name: 'removing the authenticator app',
        prepare: async () => {
          const userId = await newMember();
          await seedTotp(database, userId, {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          });
          const keeps = await seedSession(database, userId);
          return {
            userId,
            ends: await seedSession(database, userId),
            run: (tx) =>
              removeTotp(tx, {
                userId,
                password: PASSWORD,
                session: { id: keeps },
                now: next(),
              }),
          };
        },
      },
      {
        name: 'signing in with a recovery code',
        prepare: async () => {
          const userId = await newMember();
          const [code] = await generateRecoveryCodes(db(), userId, {
            now: T0,
          });
          const email = await emailOf(database, userId);
          return {
            userId,
            ends: await seedSession(database, userId),
            run: (tx) =>
              verifyRecoveryLogin(tx, { email, code: code!, now: next() }),
          };
        },
      },
      {
        name: 'disabling the person',
        prepare: async () => {
          const userId = await newMember();
          return {
            userId,
            ends: await seedSession(database, userId),
            run: (tx) => disableUser(tx, userId, { now: next() }),
          };
        },
      },
      {
        name: 'revoking the passkey that opened the session',
        prepare: async () => {
          const userId = await newMember();
          const passkeyId = await seedPasskey(database, userId);
          return {
            userId,
            // Only the sessions the passkey opened end: this is one of them.
            ends: await seedSession(database, userId, {
              method: 'passkey',
              passkeyCredentialId: passkeyId,
            }),
            run: (tx) => revokePasskey(tx, { userId, passkeyId, now: next() }),
          };
        },
      },
    ];

    describe.each(cases)('$name', ({ prepare }) => {
      it('makes a token made from the session it ends wait, then refuse it, so no token is made', async () => {
        const person = await prepare();
        const outcomes = await interleave(
          db(),
          (tx) => person.run(tx),
          (tx) => make(tx, person.userId, person.ends),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        // The refusal of the service, read from the state the revocation left, not a
        // failure of the database: the make waited for the person's row.
        expect(reasonOf(outcomes[1])).toBeInstanceOf(AuthStateError);
        expect((reasonOf(outcomes[1]) as AuthStateError).reason).toBe(
          'session-ended',
        );
        expect(await tokensOf(person.userId)).toEqual([]);
        expect(await live(person.ends)).toBe(false);
      });

      it('waits for a token that is being made, then ends the session the token was made from', async () => {
        const person = await prepare();
        const outcomes = await interleave(
          db(),
          (tx) => make(tx, person.userId, person.ends),
          (tx) => person.run(tx),
        );
        // The token was made while its session was live, so it stands; the revocation
        // came second because it waited for the make, which a lock that does not conflict
        // with the make's key-share lock would not have done.
        const made = valueOf<Awaited<ReturnType<typeof make>>>(outcomes[0]);
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await tokensOf(person.userId)).map((row) => row.id)).toEqual([
          made.apiToken.id,
        ]);
        expect(await live(person.ends)).toBe(false);
      });
    });
  },
);
