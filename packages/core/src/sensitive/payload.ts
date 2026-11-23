import { SensitivePayloadInvalidError } from './errors.js';
import {
  payloadSchemas,
  type SensitiveCategory,
  type SensitivePayload,
} from './schemas.js';

/**
 * Checks a payload against its category's schema and returns what the schema parsed, which
 * is what gets stored. Used by every write of crew personal data, so the check is the
 * same wherever the payload is kept.
 *
 * @throws SensitivePayloadInvalidError for a payload that breaks the schema; it lists
 * paths and codes, never values.
 */
export function parsePayload<C extends SensitiveCategory>(
  category: C,
  payload: unknown,
): SensitivePayload<C> {
  const parsed = payloadSchemas[category].safeParse(payload);
  if (!parsed.success) {
    throw new SensitivePayloadInvalidError(
      category,
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    );
  }
  return parsed.data as SensitivePayload<C>;
}

/**
 * Whether two payloads say the same thing: the same keys with the same values, whatever
 * order they were written in. PostgreSQL returns the keys of a stored JSON object in its
 * own order, so a plain string comparison would call a payload that was not changed
 * different.
 */
export function samePayload(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(value ?? null, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.entries(inner).sort(([x], [y]) =>
              x < y ? -1 : x > y ? 1 : 0,
            ),
          )
        : inner,
    );
  return canonical(a) === canonical(b);
}
