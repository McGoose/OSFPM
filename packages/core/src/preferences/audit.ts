/**
 * The audit categories of delivery preferences (decision D-69, P-02l2). A change to the
 * preferences of an account holder is audited and not change-logged, because the table has
 * no organisation to number it in. They are ordinary settings, so an event names the user
 * and the names of the fields that changed, and never a value: a choice such as
 * `easy-read` can hint at something the person has not chosen to share.
 */
export const PREFERENCES_AUDIT = {
  /** An account holder saved their preferences: `action` is `create` the first time and `update` after. */
  saved: 'preferences.saved',
  /** The row was erased because the account is going. Written by `eraseUserPreferences`. */
  erased: 'preferences.erased',
} as const;
