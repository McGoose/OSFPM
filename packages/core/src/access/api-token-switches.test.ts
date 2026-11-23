import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  API_PERSONAL_TOKENS_SETTING,
  API_SENSITIVE_TOKENS_SETTING,
  readApiTokenSwitches,
} from './api-token-switches.js';
import { base, seedOrganisation } from './test-fixtures.js';

/**
 * The two organisation switches for personal API tokens, as an organisation's
 * settings hold them: `api.personal-tokens` and `api.personal-tokens.sensitive`, both
 * off until a row at the organisation layer says `true`.
 */

describe('the switch keys', () => {
  it('are the two names the settings use', () => {
    expect(API_PERSONAL_TOKENS_SETTING).toBe('api.personal-tokens');
    expect(API_SENSITIVE_TOKENS_SETTING).toBe('api.personal-tokens.sensitive');
  });
});

describe.each(testTargets)('readApiTokenSwitches on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let otherId: string;
  let projectId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    const first = await seedOrganisation(database);
    organisationId = first.organisationId;
    projectId = first.projectId;
    otherId = (await seedOrganisation(database)).organisationId;
  });
  afterAll(async () => {
    await cleanup();
  });

  const setting = async (
    key: string,
    value: unknown,
    options: {
      organisation?: string;
      layer?: 'org' | 'project';
      deleted?: boolean;
    } = {},
  ) => {
    const target = options.organisation ?? organisationId;
    const layer = options.layer ?? 'org';
    await database.db.insert(settingValue).values({
      ...base(target),
      layer,
      projectId: layer === 'org' ? null : projectId,
      key,
      value,
      deletedAt: options.deleted ? new Date() : null,
    });
  };
  const clear = () => database.db.delete(settingValue);

  it('answers both off for an organisation that has no setting, which is every new one', async () => {
    await clear();
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: false,
      sensitive: false,
    });
    // An organisation that does not exist has none either: the answer is off.
    expect(
      await readApiTokenSwitches(
        database.db,
        '00000000-0000-7000-8000-000000000000',
      ),
    ).toEqual({ personalTokens: false, sensitive: false });
  });

  it('answers each switch from its own row', async () => {
    await clear();
    await setting(API_PERSONAL_TOKENS_SETTING, true);
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: true,
      sensitive: false,
    });
    await setting(API_SENSITIVE_TOKENS_SETTING, true);
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: true,
      sensitive: true,
    });
  });

  it('counts the sensitive switch only while tokens are on: it can never be on alone', async () => {
    await clear();
    await setting(API_SENSITIVE_TOKENS_SETTING, true);
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: false,
      sensitive: false,
    });
    await setting(API_PERSONAL_TOKENS_SETTING, false);
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: false,
      sensitive: false,
    });
  });

  // A switch is on only for the boolean `true`. A value that is anything else, from a
  // hand edit or a later layer that stores something richer, is off: it fails closed.
  // The string "true" is the one that needs care: Drizzle decodes a stored JSON string a
  // second time and would hand it back as the boolean, so the reader asks the database.
  it('takes only the boolean true for on', async () => {
    for (const value of [
      'true',
      '"true"',
      1,
      { enabled: true },
      [true],
      'on',
      sql`'null'::jsonb`,
    ]) {
      await clear();
      await setting(API_PERSONAL_TOKENS_SETTING, value);
      expect(
        await readApiTokenSwitches(database.db, organisationId),
        typeof value === 'object' ? 'a non-boolean' : String(value),
      ).toEqual({ personalTokens: false, sensitive: false });
    }
  });

  it('ignores a row that was deleted, a row of the project layer, and another organisation’s row', async () => {
    await clear();
    await setting(API_PERSONAL_TOKENS_SETTING, true, { deleted: true });
    await setting(API_SENSITIVE_TOKENS_SETTING, true, { layer: 'project' });
    await setting(API_PERSONAL_TOKENS_SETTING, true, { organisation: otherId });
    expect(await readApiTokenSwitches(database.db, organisationId)).toEqual({
      personalTokens: false,
      sensitive: false,
    });
    expect(await readApiTokenSwitches(database.db, otherId)).toEqual({
      personalTokens: true,
      sensitive: false,
    });
  });

  it('follows a row that is changed, the way a later write of the setting does', async () => {
    await clear();
    await setting(API_PERSONAL_TOKENS_SETTING, true);
    await database.db
      .update(settingValue)
      .set({ value: false })
      .where(eq(settingValue.key, API_PERSONAL_TOKENS_SETTING));
    expect(
      (await readApiTokenSwitches(database.db, organisationId)).personalTokens,
    ).toBe(false);
  });
});
