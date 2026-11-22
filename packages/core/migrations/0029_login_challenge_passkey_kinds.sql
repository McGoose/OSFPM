ALTER TABLE "login_challenge" DROP CONSTRAINT "login_challenge_kind_check";--> statement-breakpoint
ALTER TABLE "login_challenge" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_user_check" CHECK ("login_challenge"."user_id" is not null or "login_challenge"."kind" = 'webauthn-login');--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_kind_check" CHECK ("login_challenge"."kind" in ('totp', 'webauthn-register', 'webauthn-login'));