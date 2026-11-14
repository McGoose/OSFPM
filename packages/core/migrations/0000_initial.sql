CREATE TABLE "installation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"server_public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation" (
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
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country" text NOT NULL,
	"default_locale" text NOT NULL,
	"default_timezone" text NOT NULL,
	"base_currency" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "organisation_is_own_tenant_check" CHECK ("organisation"."organisation_id" = "organisation"."id"),
	CONSTRAINT "organisation_status_check" CHECK ("organisation"."status" in ('active', 'suspended')),
	CONSTRAINT "organisation_visibility_check" CHECK ("organisation"."visibility" in ('private', 'project', 'shared-with-partners'))
);
--> statement-breakpoint
CREATE TABLE "project" (
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
	"visibility" text DEFAULT 'project' NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"timezone" text NOT NULL,
	"locale" text NOT NULL,
	"currency" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"involves_minors" boolean DEFAULT false NOT NULL,
	CONSTRAINT "project_organisation_code_unique" UNIQUE("organisation_id","code"),
	CONSTRAINT "project_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "project_format_check" CHECK ("project"."format" in ('feature', 'series', 'short', 'commercial', 'documentary', 'other')),
	CONSTRAINT "project_status_check" CHECK ("project"."status" in ('development', 'pre-production', 'production', 'post-production', 'delivered', 'archived')),
	CONSTRAINT "project_visibility_check" CHECK ("project"."visibility" in ('private', 'project', 'shared-with-partners'))
);
--> statement-breakpoint
CREATE TABLE "user" (
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
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "user_email_lowercase_check" CHECK ("user"."email" = lower("user"."email")),
	CONSTRAINT "user_status_check" CHECK ("user"."status" in ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organisation_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_single_row" ON "installation" USING btree ((true));--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_slug_unique" ON "organisation" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" USING btree ("email");