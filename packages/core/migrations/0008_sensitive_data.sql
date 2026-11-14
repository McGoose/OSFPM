CREATE TABLE "person_sensitive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"person_id" uuid NOT NULL,
	"category" text NOT NULL,
	"payload" jsonb NOT NULL,
	"key_id" text,
	"legal_basis" text NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"consent_text_version" text,
	"entered_by_kind" text NOT NULL,
	"entered_by" uuid NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	CONSTRAINT "person_sensitive_person_category_unique" UNIQUE("person_id","category"),
	CONSTRAINT "person_sensitive_visibility_check" CHECK ("person_sensitive"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "person_sensitive_category_check" CHECK ("person_sensitive"."category" in ('dietary', 'medical', 'accessibility', 'emergency', 'identity', 'financial', 'representation', 'compliance')),
	CONSTRAINT "person_sensitive_legal_basis_check" CHECK ("person_sensitive"."legal_basis" in ('consent', 'contract', 'legal-obligation', 'vital-interest')),
	CONSTRAINT "person_sensitive_entered_by_kind_check" CHECK ("person_sensitive"."entered_by_kind" in ('self', 'staff'))
);
--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_entered_by_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;