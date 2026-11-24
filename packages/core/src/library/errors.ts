/**
 * A call on the library asked for something its rules refuse (decision D-69, P-02l2): an
 * answer about a location's access that is not yes, no or unknown, a number outside its
 * range, a detail with no answer to describe, or a field the call does not take. The message
 * names the field and the rule and carries no value and no id, so it is safe to show.
 * Nothing was written.
 */
export class LibraryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryInputError';
  }
}
