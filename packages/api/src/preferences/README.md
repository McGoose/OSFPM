# preferences

The two routes for the signed-in person's own delivery preferences (decision D-69, P-02l2): how they want to receive information. The rules are in the core (`packages/core/src/preferences/`); the routes are here.

**Entry points**

- `preferencesRoutes` (`routes.ts`): `GET` and `PUT /api/v1/me/preferences`, registered in `buildApp` with the prefix `/api/v1/me`.
- `preferencesViewSchema` (`schemas.ts`): the answer, `{ stored, effective }`, built from the core's one preferences schema, so the body, the answer and the OpenAPI document cannot drift apart.

**What they do**

- `GET` answers what the person chose (`stored`, only the fields they chose) and what applies (`effective`, every field, with the defaults filled in and `quietHours` null when there are none). A person who chose nothing gets `stored` empty.
- `PUT` replaces what they chose: a field left out is a choice cleared, and `{}` clears them all. It answers the same as `GET`.
- The body is checked strictly. A field the schema does not know, or a value it does not allow, is a 400 `validation-failed` that lists where (`body` and the field's path, `quietHours.end`) and never the value or the name the caller chose: an unknown field is reported on its parent with the code `unrecognized_keys`.
- Both answers say `cache-control: no-store`.

**Who may.** These are self-service routes: each acts only on the signed-in user's own preferences, so there is no permission to lack. A session only. No session is a 401, a `PUT` with a cookie and a foreign or missing `Origin` is a 403 `origin-mismatch`, and a recovery session (which may only secure the account) is a 403 `account-recovery-required`, because the routes do not say `allowedInRecovery`. A personal API token is a 403 `token-not-accepted`, because the routes do not say `tokenAccess`; `token-access-routes.test.ts` lists `/me` among the routes that may never accept one. The preferences of another person have no route: staff set those of a person with no account through the core service.

No log line, audit event or error holds a choice: the audit event of a save names the fields that changed and no value.

**Tests:** `preferences-routes.test.ts`: every status above, the shape of both answers, the 400 for each kind of bad body, `no-store`, one person's preferences never shown to another, and no value in the log or the audit trail.
