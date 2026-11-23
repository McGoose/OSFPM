import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  personSensitive,
  type AccessGrantCategory,
  type PersonSensitiveLegalBasis,
  type person,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { loadProfile } from './access-profile.js';
import type { SensitiveCategory } from './schemas.js';

/** A stored record without its payload. */
export type SensitiveRecordMeta = {
  readonly id: string;
  readonly personId: string;
  readonly category: SensitiveCategory;
  readonly version: number;
  readonly legalBasis: PersonSensitiveLegalBasis;
  readonly consentRecordedAt: Date | null;
  readonly consentTextVersion: string | null;
  readonly enteredByKind: 'self' | 'staff';
  readonly enteredBy: string;
  readonly lastConfirmedAt: Date | null;
  readonly updatedAt: Date;
};

/** A row of `person`. */
export type PersonRow = typeof person.$inferSelect;

/** What a `person_sensitive` row says about itself, without its payload. */
export function metaOf(
  row: typeof personSensitive.$inferSelect,
): SensitiveRecordMeta {
  return {
    id: row.id,
    personId: row.personId,
    category: row.category,
    version: row.version,
    legalBasis: row.legalBasis,
    consentRecordedAt: row.consentRecordedAt,
    consentTextVersion: row.consentTextVersion,
    enteredByKind: row.enteredByKind,
    enteredBy: row.enteredBy,
    lastConfirmedAt: row.lastConfirmedAt,
    updatedAt: row.updatedAt,
  };
}

/** The newest `person_sensitive` row of one category of one person, deleted ones too when asked. */
export async function findRow(
  tx: Tx,
  personId: string,
  category: SensitiveCategory,
  options: { includeDeleted: boolean },
) {
  const [row] = await tx
    .select()
    .from(personSensitive)
    .where(
      and(
        eq(personSensitive.personId, personId),
        eq(personSensitive.category, category),
        options.includeDeleted ? undefined : isNull(personSensitive.deletedAt),
      ),
    )
    .orderBy(desc(personSensitive.version))
    .limit(1);
  return row;
}

/** The stored data of a person in a category an access grant can open, with what it says about itself. */
export type GovernedSource = {
  readonly meta: SensitiveRecordMeta;
  readonly payload: Record<string, unknown>;
};

/**
 * Where a person's `accessibility` or `medical` data is kept (decision D-69). A person
 * with an account keeps their adjustments in their access profile, so that is read for
 * `accessibility`, and a production record of it, if one was ever written, is ignored.
 * Everything else, the adjustments of a person without an account and the medical data of
 * anyone, is the `person_sensitive` row. `null` when there is nothing stored.
 *
 * It reads and checks no permission: the caller has decided who may see what, and filters
 * the payload to it. The meta of a profile is made up from the profile, because it has no
 * legal basis or entry of its own: it is the person's own data, entered by them, on a
 * consent basis.
 */
export async function loadGovernedSource(
  tx: Tx,
  subject: PersonRow,
  category: AccessGrantCategory,
): Promise<GovernedSource | null> {
  if (category === 'accessibility' && subject.userId !== null) {
    const profile = await loadProfile(tx, subject.userId);
    if (profile === undefined) return null;
    return {
      meta: {
        id: profile.id,
        personId: subject.id,
        category,
        version: profile.version,
        legalBasis: 'consent',
        consentRecordedAt: profile.createdAt,
        consentTextVersion: null,
        enteredByKind: 'self',
        enteredBy: profile.userId,
        lastConfirmedAt: profile.updatedAt,
        updatedAt: profile.updatedAt,
      },
      payload: profile.payload,
    };
  }
  const row = await findRow(tx, subject.id, category, {
    includeDeleted: false,
  });
  if (!row || row.payload === null) return null;
  return { meta: metaOf(row), payload: row.payload };
}

/** The entries of `payload` whose key is in `keys`, and no other: what a grant lets through. */
export function pickFields(
  payload: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    // Own keys only, so a name such as `constructor` is never read from the prototype.
    if (Object.hasOwn(payload, key) && payload[key] !== undefined) {
      picked[key] = payload[key];
    }
  }
  return picked;
}
