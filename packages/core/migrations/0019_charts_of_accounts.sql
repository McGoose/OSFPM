CREATE TABLE "account_chart" (
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
	"visibility" text DEFAULT 'project' NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"format" text DEFAULT 'custom' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"copied_from_chart_id" uuid,
	CONSTRAINT "account_chart_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "account_chart_visibility_check" CHECK ("account_chart"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "account_chart_format_check" CHECK ("account_chart"."format" ~ '^[a-z0-9][a-z0-9-]*$'),
	CONSTRAINT "account_chart_key_check" CHECK ("account_chart"."key" ~ '^[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE TABLE "account" (
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
	"visibility" text DEFAULT 'project' NOT NULL,
	"chart_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_postable" boolean DEFAULT true NOT NULL,
	"gl_code" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_organisation_id_chart_id_id_unique" UNIQUE("organisation_id","chart_id","id"),
	CONSTRAINT "account_visibility_check" CHECK ("account"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "account_parent_not_self_check" CHECK ("account"."parent_id" <> "account"."id"),
	CONSTRAINT "account_code_check" CHECK ("account"."code" <> '')
);
--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_chart" ADD CONSTRAINT "account_chart_copied_from_chart_fk" FOREIGN KEY ("organisation_id","copied_from_chart_id") REFERENCES "public"."account_chart"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_account_chart_fk" FOREIGN KEY ("organisation_id","chart_id") REFERENCES "public"."account_chart"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_parent_fk" FOREIGN KEY ("organisation_id","chart_id","parent_id") REFERENCES "public"."account"("organisation_id","chart_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written: Drizzle cannot put NULLS NOT DISTINCT on an index, so the
-- generated statement was edited. An organisation template has a NULL
-- project_id, and without the clause two templates could share a key.
CREATE UNIQUE INDEX "account_chart_organisation_project_key_unique" ON "account_chart" USING btree ("organisation_id","project_id","key") NULLS NOT DISTINCT WHERE "account_chart"."deleted_at" is null;--> statement-breakpoint
-- Hand-written, for the same reason: at most one live default chart per scope,
-- counting the organisation templates as one scope.
CREATE UNIQUE INDEX "account_chart_default_unique" ON "account_chart" USING btree ("organisation_id","project_id") NULLS NOT DISTINCT WHERE "account_chart"."is_default" and "account_chart"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_chart_id_code_unique" ON "account" USING btree ("chart_id","code") WHERE "account"."deleted_at" is null;