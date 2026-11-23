import { z } from 'zod';
import {
  API_TOKEN_LIFETIME,
  API_TOKEN_MAX_SENSITIVE_PERMISSIONS,
  API_TOKEN_NAME_MAX_LENGTH,
  type ApiTokenView,
  type OrganisationApiTokenView,
} from '@osfpm/core/src/auth/api-tokens.js';
import { API_TOKEN_ACCESS } from '@osfpm/core/src/db/schema/index.js';

/** The longest key a sensitive scope takes, as the core takes it. */
const MAX_PERMISSION_KEY_LENGTH = 100;

/**
 * A personal API token as a response shows it: what it is and when it ends, never the
 * token or its hash, which are shown once and stored once, and never anything after the
 * `prefix`. `ownerDisplayName` is there only in the list that api:manage asks for.
 */
export const apiTokenSchema = z.object({
  id: z.uuid(),
  organisationId: z.uuid(),
  userId: z.uuid().describe('The person the token acts as.'),
  projectId: z
    .uuid()
    .nullable()
    .describe(
      'The one project the token works in, or null for the organisation.',
    ),
  name: z.string().describe('The name its owner gave it.'),
  prefix: z
    .string()
    .describe(
      '`osfpm_pat_` and the first 8 characters of the token, so tokens can be told apart. It is all of the token that is kept.',
    ),
  access: z.enum(API_TOKEN_ACCESS),
  sensitivePermissions: z
    .array(z.string())
    .describe(
      'The sensitive permissions the token may pass, by key. Empty for most tokens.',
    ),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe('When it ends, or null for a token that never expires.'),
  neverExpires: z
    .boolean()
    .describe('True when it never expires. Setting an expiry is advised.'),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso
    .datetime()
    .nullable()
    .describe('The last time it was used, to the minute.'),
  ownerDisplayName: z
    .string()
    .optional()
    .describe(
      'The name of the person who owns the token. Only in the list of the whole organisation (`scope=all`).',
    ),
});

/** The JSON form of an `ApiTokenView`: dates as ISO strings, and nothing else added. */
export function apiTokenBody(
  view: ApiTokenView | OrganisationApiTokenView,
): z.infer<typeof apiTokenSchema> {
  return {
    id: view.id,
    organisationId: view.organisationId,
    userId: view.userId,
    projectId: view.projectId,
    name: view.name,
    prefix: view.prefix,
    access: view.access,
    sensitivePermissions: [...view.sensitivePermissions],
    expiresAt: view.expiresAt === null ? null : view.expiresAt.toISOString(),
    neverExpires: view.neverExpires,
    createdAt: view.createdAt.toISOString(),
    lastUsedAt: view.lastUsedAt === null ? null : view.lastUsedAt.toISOString(),
    ...('ownerDisplayName' in view
      ? { ownerDisplayName: view.ownerDisplayName }
      : {}),
  };
}

/** The two switches as a response shows them. */
export const apiSettingsSchema = z.object({
  personalTokens: z
    .boolean()
    .describe('Personal API tokens are allowed in the organisation.'),
  sensitive: z
    .boolean()
    .describe(
      'A token may carry a sensitive scope. Never true while `personalTokens` is false.',
    ),
});

/** What the person changing the switches sends: both values, the sensitive one only on while tokens are. */
export const apiSettingsBody = z
  .object({
    personalTokens: z
      .boolean()
      .describe(
        'Allow personal API tokens. Turning it off ends every token of the organisation at once, and turns the sensitive switch off too.',
      ),
    sensitive: z
      .boolean()
      .describe(
        'Allow a token to carry a sensitive scope. It can only be on while `personalTokens` is. Turning it off ends every token that has a sensitive scope at once.',
      ),
  })
  .refine((body) => body.personalTokens || !body.sensitive, {
    message: 'The sensitive switch can only be on while tokens are',
    path: ['sensitive'],
  });

/** What the person making a token sends. */
export const createTokenBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(API_TOKEN_NAME_MAX_LENGTH)
      .describe(
        `A name to tell the token apart: 1 to ${API_TOKEN_NAME_MAX_LENGTH} characters, trimmed, with no control character.`,
      ),
    projectId: z
      .uuid()
      .nullish()
      .describe(
        'The one project the token works in, which the person must be able to reach. Left out or null, the whole organisation.',
      ),
    access: z
      .enum(API_TOKEN_ACCESS)
      .describe(
        '`read` calls only the routes that read, and passes only read permissions. `write` also calls the routes that change data.',
      ),
    expiresInDays: z
      .number()
      .int()
      .min(API_TOKEN_LIFETIME.minDays)
      .max(API_TOKEN_LIFETIME.maxDays)
      .optional()
      .describe(
        `How many days the token works, from ${API_TOKEN_LIFETIME.minDays} to ${API_TOKEN_LIFETIME.maxDays}. ${API_TOKEN_LIFETIME.defaultDays} when left out, unless \`noExpiry\` is set. Setting an expiry is advised.`,
      ),
    noExpiry: z
      .boolean()
      .optional()
      .describe(
        'The token never expires. It cannot be combined with `expiresInDays`, and it works until it is revoked.',
      ),
    sensitivePermissions: z
      .array(z.string().min(1).max(MAX_PERMISSION_KEY_LENGTH))
      .max(API_TOKEN_MAX_SENSITIVE_PERMISSIONS)
      .optional()
      .describe(
        'The sensitive permissions the token may pass, by key (for example `sensitive:read:medical`). Needs the organisation’s sensitive switch on, and the person must hold each one where the token works. Left out, none.',
      ),
  })
  .refine(
    (body) => !(body.noExpiry === true && body.expiresInDays !== undefined),
    {
      message: 'noExpiry cannot be combined with expiresInDays',
      path: ['noExpiry'],
    },
  );
