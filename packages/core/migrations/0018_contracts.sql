CREATE TABLE "contract_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'contract' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"contract_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "contract_link_contract_entity_type_entity_unique" UNIQUE("contract_id","entity_type","entity_id"),
	CONSTRAINT "contract_link_visibility_check" CHECK ("contract_link"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "contract_link_entity_type_check" CHECK ("contract_link"."entity_type" in ('project', 'person', 'company', 'location', 'unit', 'episode'))
);
--> statement-breakpoint
CREATE TABLE "contract_party" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'contract' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"contract_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"party_role" text NOT NULL,
	CONSTRAINT "contract_party_contract_person_company_role_unique" UNIQUE NULLS NOT DISTINCT("contract_id","person_id","company_id","party_role"),
	CONSTRAINT "contract_party_visibility_check" CHECK ("contract_party"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "contract_party_one_party_check" CHECK (("contract_party"."person_id" is null) <> ("contract_party"."company_id" is null))
);
--> statement-breakpoint
CREATE TABLE "contract" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'contract' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"signed_on" date,
	"effective_from" date,
	"effective_to" date,
	"territories" text[] DEFAULT '{}' NOT NULL,
	"currency" text,
	"total_value" numeric(19, 4),
	CONSTRAINT "contract_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "contract_visibility_check" CHECK ("contract"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "contract_kind_check" CHECK ("contract"."kind" in ('deal-memo', 'crew-contract', 'cast-contract', 'location-agreement', 'release', 'chain-of-title', 'option', 'insurance-certificate', 'co-production-agreement', 'financing-agreement', 'sales-agency', 'distribution', 'music-licence', 'other')),
	CONSTRAINT "contract_status_check" CHECK ("contract"."status" in ('draft', 'negotiating', 'signed', 'active', 'expired', 'terminated')),
	CONSTRAINT "contract_effective_period_check" CHECK ("contract"."effective_from" is null or "contract"."effective_to" is null or "contract"."effective_to" >= "contract"."effective_from"),
	CONSTRAINT "contract_currency_check" CHECK ("contract"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "contract_total_value_currency_check" CHECK ("contract"."total_value" is null or "contract"."currency" is not null),
	CONSTRAINT "contract_territories_check" CHECK ("contract"."territories"::text ~ '^[{]([A-Z]{2}(,[A-Z]{2})*)?[}]$')
);
--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_link" ADD CONSTRAINT "contract_link_contract_fk" FOREIGN KEY ("organisation_id","contract_id") REFERENCES "public"."contract"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_contract_fk" FOREIGN KEY ("organisation_id","contract_id") REFERENCES "public"."contract"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_party" ADD CONSTRAINT "contract_party_company_fk" FOREIGN KEY ("organisation_id","company_id") REFERENCES "public"."company"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;