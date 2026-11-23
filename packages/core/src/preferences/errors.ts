/**
 * The preferences do not fit their schema (`preferences/schemas.ts`). It lists where and
 * why, as paths and codes, and never what the caller sent: a value that was refused is not
 * put in the message or in `issues`. Nothing was written. The path of a field is its name,
 * or `quietHours.end`; a field the schema does not know is reported on its parent, with
 * the code `unrecognized_keys`, and not by name.
 */
export class PreferencesInvalidError extends Error {
  constructor(readonly issues: readonly { path: string; code: string }[]) {
    super(
      'Invalid preferences' +
        (issues.length > 0
          ? ` at: ${issues.map((issue) => issue.path || '(root)').join(', ')}`
          : ''),
    );
    this.name = 'PreferencesInvalidError';
  }
}

/**
 * Staff tried to set the preferences of a person who has an account. Those are the
 * person's own and are kept on their account (`user_preferences`), so only they change
 * them, by signing in (decision D-69, P-02l2). Nothing was written. It carries nothing: not
 * the person and not a preference.
 */
export class UseAccountPreferencesError extends Error {
  constructor() {
    super('A person with an account keeps their preferences on their account');
    this.name = 'UseAccountPreferencesError';
  }
}
