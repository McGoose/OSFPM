import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readApiTokenSwitches } from '../access/api-token-switches.js';
import type { Database } from '../db/client.js';
import { apiToken, auditEvent, settingValue } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import {
  ApiSensitiveTokensDisabledError,
  ApiTokensDisabledError,
} from './api-token-errors.js';
import {
  createApiToken,
  revokeApiToken,
  revokeOwnApiToken,
  setApiTokenSwitches,
  type ApiTokenSwitchesResult,
  type CreateApiTokenInput,
} from './api-tokens.js';
import { AUTH_AUDIT } from './shared.js';
import {
  seedApiToken,
  seedTokenScene,
  type TokenScene,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A time no other call uses, so a row can be told from the ones before it. */
let clock = 0;
const next = () => at((clock += 1) * MINUTE);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

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

/** A token with a sensitive scope: the owner holds this permission in the organisation. */
const SENSITIVE_SCOPE = ['sensitive:read:medical'];

/**
 * Personal API tokens racing the switches, and each other (SC-10, decision D-68; CLAUDE.md,
 * Data rules: the organisation's change counter comes before any row lock). Each ordered
 * case holds one transaction open after its work while the other starts, and waits until
 * the second is blocked on a lock (`interleave`), so the two really overlap and the order
 * is the one the test names. They need two real sessions, so they run on PostgreSQL and
 * are skipped on PGlite.
 *
 * What they pin: a token is never left working when the organisation's switches do not
 * allow it, whichever of the making and the switching off comes first (the counter, taken
 * before the switches are read, is what queues them), and two revokes of one token end
 * with one revocation, the other being a not found.
 */
describe.skipIf(postgres === undefined)(
  'personal API tokens racing, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: TokenScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
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

    /** Sets both switches, as the owner does. */
    const turn = (
      personalTokens: boolean,
      sensitive: boolean,
      tx: Pick<Database, 'db'>['db'] = db(),
    ) =>
      setApiTokenSwitches(
        tx,
        { userId: scene.ownerId },
        scene.organisationId,
        { personalTokens, sensitive },
        next(),
      );
    /** Makes a token as the owner, who holds everything in the organisation. */
    const make = (
      tx: Pick<Database, 'db'>['db'],
      input: Partial<CreateApiTokenInput> = {},
    ) =>
      createApiToken(
        tx,
        { userId: scene.ownerId },
        scene.organisationId,
        { name: 'Call sheet export', access: 'read', ...input },
        next(),
      );
    /** The tokens of the organisation that still work, by id. */
    const working = async () =>
      (await db().select().from(apiToken))
        .filter(
          (row) =>
            row.organisationId === scene.organisationId &&
            row.revokedAt === null &&
            (row.expiresAt === null || row.expiresAt > T0),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
    const switches = () => readApiTokenSwitches(db(), scene.organisationId);
    /**
     * The one rule the switches exist for, read from the rows themselves: no token works
     * while tokens are off, and none with a sensitive scope works while the sensitive
     * switch is off.
     */
    const expectNoTokenTheSwitchesRefuse = async (label: string) => {
      const now = await switches();
      const live = await working();
      if (!now.personalTokens) {
        expect(live, `${label}: tokens are off`).toEqual([]);
      }
      if (!now.sensitive) {
        expect(
          live.filter((row) => row.sensitivePermissions.length > 0),
          `${label}: the sensitive switch is off`,
        ).toEqual([]);
      }
    };

    describe('making a token against turning tokens off', () => {
      it('is refused when the switching off holds the counter first, and no token is left', async () => {
        await turn(true, false);
        const outcomes = await interleave(
          db(),
          (tx) => turn(false, false, tx),
          (tx) => make(tx),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        // The refusal of the service, not a failure of the database: the make waited
        // for the counter, then read the switch as the switching off left it.
        expect(reasonOf(outcomes[1])).toBeInstanceOf(ApiTokensDisabledError);
        expect(await working()).toEqual([]);
        expect(await switches()).toEqual({
          personalTokens: false,
          sensitive: false,
        });
      });

      it('is made and then revoked when the making holds the counter first, and the switching off counts it', async () => {
        await turn(true, false);
        const outcomes = await interleave(
          db(),
          (tx) => make(tx),
          (tx) => turn(false, false, tx),
        );
        const made = valueOf<Awaited<ReturnType<typeof make>>>(outcomes[0]);
        const switched = valueOf<ApiTokenSwitchesResult>(outcomes[1]);
        // The switching off could see the new token because it waited for the counter.
        expect(switched.revoked).toBe(1);
        expect(await working()).toEqual([]);
        const row = (await db().select().from(apiToken)).find(
          (found) => found.id === made.apiToken.id,
        )!;
        expect(row.revokedAt).not.toBeNull();
        expect(row.revokeReason).toBe('switch-off');
      });
    });

    describe('making a token with a sensitive scope against turning the sensitive switch off', () => {
      it('is refused when the switching off holds the counter first, though tokens stay on', async () => {
        await turn(true, true);
        const outcomes = await interleave(
          db(),
          (tx) => turn(true, false, tx),
          (tx) => make(tx, { sensitivePermissions: SENSITIVE_SCOPE }),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(
          ApiSensitiveTokensDisabledError,
        );
        expect(await working()).toEqual([]);
        expect(await switches()).toEqual({
          personalTokens: true,
          sensitive: false,
        });
      });

      it('is made and then revoked when the making holds the counter first, and a token without a scope stays', async () => {
        await turn(true, true);
        const plain = await make(db());
        const outcomes = await interleave(
          db(),
          (tx) => make(tx, { sensitivePermissions: SENSITIVE_SCOPE }),
          (tx) => turn(true, false, tx),
        );
        const scoped = valueOf<Awaited<ReturnType<typeof make>>>(outcomes[0]);
        expect(valueOf<ApiTokenSwitchesResult>(outcomes[1]).revoked).toBe(1);
        // Only the token with a scope ended; tokens are still on.
        expect((await working()).map((row) => row.id)).toEqual([
          plain.apiToken.id,
        ]);
        const row = (await db().select().from(apiToken)).find(
          (found) => found.id === scoped.apiToken.id,
        )!;
        expect(row.revokeReason).toBe('switch-off');
      });
    });

    describe.each([
      {
        name: 'tokens off',
        scope: [] as string[],
        before: [true, true] as const,
        after: [false, false] as const,
        refusal: ApiTokensDisabledError,
      },
      {
        name: 'the sensitive switch off',
        scope: SENSITIVE_SCOPE,
        before: [true, true] as const,
        after: [true, false] as const,
        refusal: ApiSensitiveTokensDisabledError,
      },
    ])('a token made and $name started together', (variant) => {
      it('never leaves a token working that the switches do not allow, however the two are ordered', async () => {
        for (let round = 0; round < 8; round += 1) {
          await turn(...variant.before);
          const outcomes = await Promise.allSettled([
            db().transaction((tx) =>
              make(tx, { sensitivePermissions: variant.scope }),
            ),
            db().transaction((tx) =>
              turn(variant.after[0], variant.after[1], tx),
            ),
          ]);
          const label = `${variant.name}, round ${round}`;
          // The switching off always goes through: it is never the one that loses.
          const switched = valueOf<ApiTokenSwitchesResult>(outcomes[1]);
          // The making either went through before it, and was ended by it, or was
          // refused after it. Never a deadlock or any other failure of the database.
          if (outcomes[0].status === 'fulfilled') {
            expect(switched.revoked, label).toBe(1);
          } else {
            expect(reasonOf(outcomes[0]), label).toBeInstanceOf(
              variant.refusal,
            );
            expect(switched.revoked, label).toBe(0);
          }
          await expectNoTokenTheSwitchesRefuse(label);
        }
      });
    });

    describe('two revokes of one token', () => {
      /** How many revocations of the token the audit trail holds. */
      const revocationsOf = async (tokenId: string) =>
        (await db().select().from(auditEvent)).filter(
          (event) =>
            event.category === AUTH_AUDIT.apiTokenRevoked &&
            event.targetId === tokenId,
        );

      it('ends with the first one, and a not found for the manager who arrives second', async () => {
        const token = await seedApiToken(
          database,
          scene.organisationId,
          scene.ownerId,
        );
        const outcomes = await interleave(
          db(),
          (tx) =>
            revokeOwnApiToken(
              tx,
              { userId: scene.ownerId },
              scene.organisationId,
              token.id,
              next(),
            ),
          (tx) =>
            revokeApiToken(
              tx,
              { userId: scene.managerId },
              scene.organisationId,
              token.id,
              next(),
            ),
        );
        expect(succeeded(outcomes)).toBe(1);
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(RecordNotFoundError);
        const row = (await db().select().from(apiToken)).find(
          (found) => found.id === token.id,
        )!;
        expect(row.revokedBy).toBe(scene.ownerId);
        expect(row.revokeReason).toBe('manual');
        expect(await revocationsOf(token.id)).toHaveLength(1);
      });

      it('ends with the first one, and a not found for the owner who arrives second', async () => {
        const token = await seedApiToken(
          database,
          scene.organisationId,
          scene.ownerId,
        );
        const outcomes = await interleave(
          db(),
          (tx) =>
            revokeApiToken(
              tx,
              { userId: scene.managerId },
              scene.organisationId,
              token.id,
              next(),
            ),
          (tx) =>
            revokeOwnApiToken(
              tx,
              { userId: scene.ownerId },
              scene.organisationId,
              token.id,
              next(),
            ),
        );
        expect(succeeded(outcomes)).toBe(1);
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(RecordNotFoundError);
        const row = (await db().select().from(apiToken)).find(
          (found) => found.id === token.id,
        )!;
        expect(row.revokedBy).toBe(scene.managerId);
        expect(await revocationsOf(token.id)).toHaveLength(1);
      });

      it('makes one revocation when many start together, and the others are a not found', async () => {
        const token = await seedApiToken(
          database,
          scene.organisationId,
          scene.ownerId,
        );
        const outcomes = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            db().transaction((tx) =>
              revokeOwnApiToken(
                tx,
                { userId: scene.ownerId },
                scene.organisationId,
                token.id,
                next(),
              ),
            ),
          ),
        );
        expect(succeeded(outcomes)).toBe(1);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toBeInstanceOf(RecordNotFoundError);
          }
        }
        expect(await revocationsOf(token.id)).toHaveLength(1);
      });
    });
  },
);
