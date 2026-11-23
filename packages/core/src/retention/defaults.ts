/**
 * Keys of the retention classes seeded by migrations `0013_seed_retention_classes`,
 * `0027_transient_retention_class` and `0036_account_lifetime_retention_class`.
 */
export const RETENTION_CLASS_KEYS = [
  'standard',
  'financial-record',
  'contract',
  'crew-personal',
  'crew-health',
  'minor-record',
  'security-log',
  'transient',
  'account-lifetime',
] as const;
/** One value of `RETENTION_CLASS_KEYS`. */
export type RetentionClassKey = (typeof RETENTION_CLASS_KEYS)[number];

/** The shipped period for one retention class, and whether it is verified. */
export type RetentionDefault = {
  /**
   * Whole years to keep a record after its anchor date. `null` means no
   * automatic purge: the record is kept until someone decides.
   */
  readonly periodYears: number | null;
  /** Whether a lawyer has confirmed the period for the install's jurisdiction. */
  readonly verified: boolean;
};

/**
 * Periods that ship with OSFPM, one per class. They are starting points, not
 * legal advice, so none is verified. Installs and rule packs will override
 * them later; until then this constant is the only place periods live. This is
 * the exception CLAUDE.md, Data rules allows for shipped defaults marked
 * `verified: false`: never repeat a period elsewhere.
 *
 * `transient` has no period on purpose: its rows are working rows that cleanup
 * removes, and the audit log is the record (maintainer decision, P-03b3a).
 *
 * `account-lifetime` has none either: a row of that class belongs to an account,
 * not to a production, so it is kept while the account exists and ends when the
 * person deletes it or the account goes, never on a date (decision D-69, P-02l1).
 */
export const SHIPPED_RETENTION_DEFAULTS: Readonly<
  Record<RetentionClassKey, RetentionDefault>
> = {
  standard: { periodYears: null, verified: false },
  'financial-record': { periodYears: 10, verified: false },
  contract: { periodYears: 10, verified: false },
  'crew-personal': { periodYears: null, verified: false },
  'crew-health': { periodYears: null, verified: false },
  'minor-record': { periodYears: null, verified: false },
  'security-log': { periodYears: null, verified: false },
  transient: { periodYears: null, verified: false },
  'account-lifetime': { periodYears: null, verified: false },
};
