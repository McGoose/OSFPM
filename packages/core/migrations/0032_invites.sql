CREATE TABLE "invite" (
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
	"token_hash" text NOT NULL,
	"email" text,
	"tier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "invite_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invite_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "invite_email_normalised_check" CHECK ("invite"."email" is null or ("invite"."email" = lower("invite"."email") and "invite"."email" !~ '[[:space:]]' and "invite"."email" like '%_@_%')),
	CONSTRAINT "invite_tier_check" CHECK ("invite"."tier" in ('admin', 'member', 'supervisor', 'guest')),
	CONSTRAINT "invite_used_pair_check" CHECK (("invite"."used_at" is null) = ("invite"."used_by" is null)),
	CONSTRAINT "invite_revoked_pair_check" CHECK (("invite"."revoked_at" is null) = ("invite"."revoked_by" is null)),
	CONSTRAINT "invite_not_used_and_revoked_check" CHECK ("invite"."used_at" is null or "invite"."revoked_at" is null),
	CONSTRAINT "invite_expiry_check" CHECK ("invite"."expires_at" > "invite"."created_at")
);
--> statement-breakpoint
CREATE TABLE "invite_role" (
	"organisation_id" uuid NOT NULL,
	"invite_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "invite_role_pk" PRIMARY KEY("invite_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_used_by_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_revoked_by_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_role" ADD CONSTRAINT "invite_role_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_role" ADD CONSTRAINT "invite_role_invite_fk" FOREIGN KEY ("organisation_id","invite_id") REFERENCES "public"."invite"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_role" ADD CONSTRAINT "invite_role_role_fk" FOREIGN KEY ("organisation_id","role_id") REFERENCES "public"."role"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_role_role_idx" ON "invite_role" USING btree ("organisation_id","role_id");