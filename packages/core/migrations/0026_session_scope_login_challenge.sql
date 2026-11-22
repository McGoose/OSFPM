CREATE TABLE "login_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'security-log' NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "login_challenge_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "login_challenge_kind_check" CHECK ("login_challenge"."kind" in ('totp')),
	CONSTRAINT "login_challenge_attempts_check" CHECK ("login_challenge"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenge" ADD CONSTRAINT "login_challenge_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_challenge_user_idx" ON "login_challenge" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_event_target_occurred_idx" ON "audit_event" USING btree ("target_id","occurred_at");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_scope_check" CHECK ("session"."scope" in ('full', 'recovery'));