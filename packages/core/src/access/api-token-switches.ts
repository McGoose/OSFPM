import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { settingValue } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * The two organisation switches for personal API tokens (SC-10, decision D-68),
 * kept as organisation-level settings: a row of `setting_value` at the `org` layer
 * with the key below and the JSON value `true` or `false`. Both are off by default,
 * which is a row that is not there. There is no settings service yet (the settings
 * inheritance of P-04 will bring one), so these two keys are read here and written by
 * `setApiTokenSwitches` (`src/auth/`), through the write helper like any tenant record.
 *
 * `access/` reads them because the narrowing of a token's permission checks needs the
 * sensitive switch (`credential.ts`), and `auth/` imports from `access/`, not the
 * other way round.
 */

/**
 * The key of the switch that allows personal API tokens at all. Off, no token of the
 * organisation works and none can be made; turning it off revokes every one.
 */
export const API_PERSONAL_TOKENS_SETTING = 'api.personal-tokens';

/**
 * The key of the switch that allows a token to carry a sensitive scope. It only counts
 * while `api.personal-tokens` is on. Off, no token passes a sensitive permission and
 * none can be made with a sensitive scope; turning it off revokes every token that has
 * one.
 */
export const API_SENSITIVE_TOKENS_SETTING = 'api.personal-tokens.sensitive';

/** The two keys, in the order the switches are listed. */
export const API_TOKEN_SETTING_KEYS = [
  API_PERSONAL_TOKENS_SETTING,
  API_SENSITIVE_TOKENS_SETTING,
] as const;
/** One value of `API_TOKEN_SETTING_KEYS`. */
export type ApiTokenSettingKey = (typeof API_TOKEN_SETTING_KEYS)[number];

/**
 * What the two switches say for an organisation. `sensitive` is already the effective
 * answer: it is true only while `personalTokens` is, so a stored sensitive switch that
 * is on with tokens off reads as off.
 */
export type ApiTokenSwitches = {
  /** Personal API tokens are allowed. */
  readonly personalTokens: boolean;
  /** A token may carry a sensitive scope. Never true while `personalTokens` is false. */
  readonly sensitive: boolean;
};

/** A stored switch: the row's id and version, for the writer, and whether it says on. */
export type ApiTokenSettingRow = {
  readonly id: string;
  readonly key: ApiTokenSettingKey;
  /** Whether the stored value is the JSON `true`, and nothing else. */
  readonly on: boolean;
  readonly version: number;
};

/**
 * The stored rows of the two switches of one organisation: the live rows at the `org`
 * layer, with no project, under the two keys. A deleted row, a row of the project
 * layer and another organisation's row are not here. There are at most two, because
 * the table keeps one row per key and layer. Reads without a lock, and checks no
 * permission: the caller has decided who may know. `setApiTokenSwitches` calls it
 * after it holds the organisation's change counter.
 *
 * Whether a row is on is decided by the database (`value = 'true'::jsonb`), not by the
 * driver: Drizzle decodes a stored JSON string a second time, so the string `"true"`
 * would come back as the boolean `true`, and a switch must be on for the boolean only.
 */
export async function apiTokenSettingRows(
  tx: Tx,
  organisationId: string,
): Promise<ApiTokenSettingRow[]> {
  const rows = await tx
    .select({
      id: settingValue.id,
      key: settingValue.key,
      on: sql<boolean>`${settingValue.value} = 'true'::jsonb`,
      version: settingValue.version,
    })
    .from(settingValue)
    .where(
      and(
        eq(settingValue.organisationId, organisationId),
        eq(settingValue.layer, 'org'),
        isNull(settingValue.projectId),
        inArray(settingValue.key, [...API_TOKEN_SETTING_KEYS]),
        isNull(settingValue.deletedAt),
      ),
    );
  // The query asked for these two keys only.
  return rows as ApiTokenSettingRow[];
}

/**
 * What the two switches say, from the rows `apiTokenSettingRows` read. A switch is on
 * only for the boolean `true`: any other stored value is off, so a hand edit or a later
 * layer that stores something richer fails closed. The sensitive switch counts only
 * while tokens are on.
 */
export function switchesFromRows(
  rows: readonly ApiTokenSettingRow[],
): ApiTokenSwitches {
  const isOn = (key: ApiTokenSettingKey) =>
    rows.some((row) => row.key === key && row.on);
  const personalTokens = isOn(API_PERSONAL_TOKENS_SETTING);
  return {
    personalTokens,
    sensitive: personalTokens && isOn(API_SENSITIVE_TOKENS_SETTING),
  };
}

/**
 * The two switches of an organisation, both off when it has no setting, which is the
 * state of every new organisation. An organisation that does not exist has none, so
 * the answer is off. Reads without a lock, and checks no permission: the callers are the
 * services that decide who may ask (`createApiToken`, `authenticateApiToken`, the
 * narrowing of a token's permission checks, `api:manage` for the settings route).
 */
export async function readApiTokenSwitches(
  tx: Tx,
  organisationId: string,
): Promise<ApiTokenSwitches> {
  return switchesFromRows(await apiTokenSettingRows(tx, organisationId));
}
