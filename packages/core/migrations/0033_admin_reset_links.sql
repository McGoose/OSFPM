CREATE TABLE "access_reset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'transient' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"remove_passkeys" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "access_reset_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "access_reset_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "access_reset_revoked_pair_check" CHECK (("access_reset"."revoked_at" is null) = ("access_reset"."revoked_by" is null)),
	CONSTRAINT "access_reset_not_used_and_revoked_check" CHECK ("access_reset"."used_at" is null or "access_reset"."revoked_at" is null),
	CONSTRAINT "access_reset_expiry_check" CHECK ("access_reset"."expires_at" > "access_reset"."created_at"),
	CONSTRAINT "access_reset_not_self_check" CHECK ("access_reset"."user_id" <> "access_reset"."created_by")
);
--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_method_check";--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_org_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "public"."org_membership"("organisation_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reset" ADD CONSTRAINT "access_reset_revoked_by_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_reset_organisation_user_idx" ON "access_reset" USING btree ("organisation_id","user_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_method_check" CHECK ("session"."method" in ('passkey', 'password', 'password+totp', 'recovery', 'setup', 'invite', 'reset'));