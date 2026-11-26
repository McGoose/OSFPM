-- Reset links issued by the system, for the admin command `emergency-access`
-- (P-09a2, decision D-81). The statements below are as drizzle-kit generated them;
-- only the comments are written by hand.
--
-- Two checks are replaced, so they are dropped first and added again further down,
-- once what they refer to exists. `access_reset_revoked_pair_check` only knew
-- `revoked_by`, and a revocation now names a person or the system. `api_token`'s
-- list of revoke reasons gains `admin-action`, for `revoke-sessions
-- --include-api-tokens`; the CHECK is built from that list, so it is replaced too.
ALTER TABLE "access_reset" DROP CONSTRAINT "access_reset_revoked_pair_check";--> statement-breakpoint
ALTER TABLE "api_token" DROP CONSTRAINT "api_token_revoke_reason_check";--> statement-breakpoint
-- Who issued a link: the system, when there is no creator. Existing rows were all
-- made by a person, so the default (false) is true of every one of them.
ALTER TABLE "access_reset" ADD COLUMN "issued_by_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Who revoked a link, when it was not a person: the system, which is how the admin
-- command supersedes an earlier link. Existing revocations were all by a person.
ALTER TABLE "access_reset" ADD COLUMN "revoked_by_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A revocation names a person or the system, never both. With the pair check added
-- below, a revoked link has exactly one revoker.
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_revoker_one_check" CHECK ("access_reset"."revoked_by" is null or not "access_reset"."revoked_by_system");--> statement-breakpoint
-- The system issued a link exactly when it has no creator. The service has always
-- set `created_by`, so no existing row has none; a row made by hand that does would
-- stop this migration, which is right: a migration never decides what such a row
-- is, because that would change security state (CLAUDE.md, Data rules).
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_issuer_check" CHECK ("access_reset"."issued_by_system" = ("access_reset"."created_by" is null));--> statement-breakpoint
-- The pair check again, under its own name, now for both kinds of revoker: a link
-- is revoked when, and only when, a person or the system is named as the revoker.
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_revoked_pair_check" CHECK (("access_reset"."revoked_at" is null) = ("access_reset"."revoked_by" is null and not "access_reset"."revoked_by_system"));--> statement-breakpoint
-- The reason list again, with `admin-action`. A token the admin command revokes has
-- no `revoked_by`: the system acted, which the reason says.
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_revoke_reason_check" CHECK ("api_token"."revoke_reason" is null or "api_token"."revoke_reason" in ('manual', 'switch-off', 'access-reset', 'membership-ended', 'admin-action'));
