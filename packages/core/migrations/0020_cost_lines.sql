CREATE TABLE "cost_line_scheme" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'financial-record' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"cost_line_id" uuid NOT NULL,
	"scheme_key" text NOT NULL,
	"status" text NOT NULL,
	"qualifying_amount" numeric(19, 4),
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "cost_line_scheme_visibility_check" CHECK ("cost_line_scheme"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "cost_line_scheme_scheme_key_check" CHECK ("cost_line_scheme"."scheme_key" ~ '^[a-z0-9][a-z0-9.-]*$'),
	CONSTRAINT "cost_line_scheme_status_check" CHECK ("cost_line_scheme"."status" in ('qualifying', 'non-qualifying', 'pending', 'excluded')),
	CONSTRAINT "cost_line_scheme_qualifying_amount_check" CHECK ("cost_line_scheme"."status" = 'qualifying' or "cost_line_scheme"."qualifying_amount" is null),
	CONSTRAINT "cost_line_scheme_decided_check" CHECK (("cost_line_scheme"."decided_by" is null) = ("cost_line_scheme"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "cost_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'financial-record' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"project_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"territory" text NOT NULL,
	"production_phase" text NOT NULL,
	"payee_company_id" uuid,
	"payee_person_id" uuid,
	"cost_date" date,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(19, 10),
	"amount_project_currency" numeric(19, 4) NOT NULL,
	"episode_id" uuid,
	"unit_id" uuid,
	CONSTRAINT "cost_line_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "cost_line_visibility_check" CHECK ("cost_line"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "cost_line_stage_check" CHECK ("cost_line"."stage" in ('budget', 'committed', 'actual')),
	CONSTRAINT "cost_line_source_type_check" CHECK ("cost_line"."source_type" in ('budget', 'purchase-order', 'invoice', 'expense', 'timesheet', 'other')),
	CONSTRAINT "cost_line_production_phase_check" CHECK ("cost_line"."production_phase" in ('development', 'pre-production', 'principal-photography', 'post-production', 'delivery', 'distribution')),
	CONSTRAINT "cost_line_source_id_check" CHECK ("cost_line"."source_type" = 'other' or "cost_line"."source_id" is not null),
	CONSTRAINT "cost_line_territory_check" CHECK ("cost_line"."territory" ~ '^[A-Z]{2}$'),
	CONSTRAINT "cost_line_currency_check" CHECK ("cost_line"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "cost_line_fx_rate_check" CHECK ("cost_line"."fx_rate" is null or "cost_line"."fx_rate" > 0),
	CONSTRAINT "cost_line_one_payee_check" CHECK ("cost_line"."payee_company_id" is null or "cost_line"."payee_person_id" is null),
	CONSTRAINT "cost_line_description_check" CHECK ("cost_line"."description" <> '')
);
--> statement-breakpoint
-- Hand-written reordering: Drizzle emitted these three UNIQUE constraints last,
-- but the cost_line foreign keys below need them as their targets, and
-- PostgreSQL refuses a foreign key whose target key does not exist yet. Moved
-- here, ahead of the foreign keys, unchanged.
ALTER TABLE "account" ADD CONSTRAINT "account_organisation_id_id_unique" UNIQUE("organisation_id","id");--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_organisation_project_id_unique" UNIQUE("organisation_id","project_id","id");--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_organisation_project_id_unique" UNIQUE("organisation_id","project_id","id");--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_created_by_user_id_fk"FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_cost_line_fk" FOREIGN KEY ("organisation_id","cost_line_id") REFERENCES "public"."cost_line"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line_scheme" ADD CONSTRAINT "cost_line_scheme_user_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_account_fk" FOREIGN KEY ("organisation_id","account_id") REFERENCES "public"."account"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_person_fk" FOREIGN KEY ("organisation_id","payee_person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_company_fk" FOREIGN KEY ("organisation_id","payee_company_id") REFERENCES "public"."company"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_unit_fk" FOREIGN KEY ("organisation_id","project_id","unit_id") REFERENCES "public"."unit"("organisation_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_episode_fk" FOREIGN KEY ("organisation_id","project_id","episode_id") REFERENCES "public"."episode"("organisation_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_line_scheme_cost_line_key_unique" ON "cost_line_scheme" USING btree ("cost_line_id","scheme_key") WHERE "cost_line_scheme"."deleted_at" is null;