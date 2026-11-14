CREATE TABLE "legal_hold" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'standard' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'project' NOT NULL,
	"project_id" uuid,
	"entity_type" text,
	"entity_id" uuid,
	"reason" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	CONSTRAINT "legal_hold_visibility_check" CHECK ("legal_hold"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "legal_hold_entity_check" CHECK (("legal_hold"."entity_type" is null) = ("legal_hold"."entity_id" is null)),
	CONSTRAINT "legal_hold_release_check" CHECK (("legal_hold"."released_at" is null) = ("legal_hold"."released_by" is null) and ("legal_hold"."released_at" is null) = ("legal_hold"."release_reason" is null)),
	CONSTRAINT "legal_hold_released_after_placed_check" CHECK ("legal_hold"."released_at" is null or "legal_hold"."released_at" >= "legal_hold"."placed_at"),
	CONSTRAINT "legal_hold_not_deleted_check" CHECK ("legal_hold"."deleted_at" is null)
);
--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_released_by_fk" FOREIGN KEY ("released_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;