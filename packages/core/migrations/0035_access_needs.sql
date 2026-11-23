-- No data migration (decision D-69). The accessibility payload of person_sensitive
-- changed from { needs, notes } to structured adjustments (src/sensitive/schemas.ts),
-- and a row written in the old shape is not converted: no real accessibility data
-- exists yet, so there is nothing to convert. The two tables below start empty.
-- The statements that follow are the ones drizzle generated; this comment is the only
-- hand-written part of the file.
CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'crew-health' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"category" text NOT NULL,
	"role_id" uuid NOT NULL,
	"fields" text[] NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"on_behalf" boolean NOT NULL,
	"consent_method" text,
	"consent_at" timestamp with time zone,
	"consent_note" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "access_grant_category_check" CHECK ("access_grant"."category" in ('accessibility', 'medical')),
	CONSTRAINT "access_grant_consent_method_check" CHECK ("access_grant"."consent_method" is null or "access_grant"."consent_method" in ('in-person', 'phone', 'email', 'written', 'other')),
	CONSTRAINT "access_grant_fields_check" CHECK (cardinality("access_grant"."fields") > 0 and osfpm_text_array_is_distinct("access_grant"."fields")),
	CONSTRAINT "access_grant_consent_check" CHECK (("access_grant"."on_behalf" and "access_grant"."consent_method" is not null and "access_grant"."consent_at" is not null) or (not "access_grant"."on_behalf" and "access_grant"."consent_method" is null and "access_grant"."consent_at" is null)),
	CONSTRAINT "access_grant_consent_note_check" CHECK ("access_grant"."consent_note" is null or ("access_grant"."on_behalf" and char_length("access_grant"."consent_note") between 1 and 200)),
	CONSTRAINT "access_grant_revoked_pair_check" CHECK (("access_grant"."revoked_at" is null) = ("access_grant"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "user_access_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'crew-health' NOT NULL,
	"user_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"key_id" text,
	CONSTRAINT "user_access_profile_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_role_fk" FOREIGN KEY ("organisation_id","role_id") REFERENCES "public"."role"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_granted_by_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_revoked_by_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_profile" ADD CONSTRAINT "user_access_profile_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_profile" ADD CONSTRAINT "user_access_profile_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_profile" ADD CONSTRAINT "user_access_profile_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_profile" ADD CONSTRAINT "user_access_profile_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_profile" ADD CONSTRAINT "user_access_profile_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grant_live_unique" ON "access_grant" USING btree ("project_id","person_id","category","role_id") WHERE "access_grant"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "access_grant_person_idx" ON "access_grant" USING btree ("organisation_id","person_id");