CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid,
	"project_id" uuid,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"details" jsonb,
	"ip_address" "inet",
	"request_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_event_actor_type_check" CHECK ("audit_event"."actor_type" in ('user', 'token', 'system', 'email', 'federation'))
);
--> statement-breakpoint
CREATE TABLE "change_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid,
	"seq" bigint NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changed_fields" text[] NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"entity_version" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"request_id" text,
	"origin_server" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "change_event_organisation_project_seq_unique" UNIQUE NULLS NOT DISTINCT("organisation_id","project_id","seq"),
	CONSTRAINT "change_event_action_check" CHECK ("change_event"."action" in ('create', 'update', 'delete', 'restore')),
	CONSTRAINT "change_event_actor_type_check" CHECK ("change_event"."actor_type" in ('user', 'token', 'system', 'email', 'federation'))
);
--> statement-breakpoint
CREATE TABLE "change_seq" (
	"organisation_id" uuid NOT NULL,
	"project_id" uuid,
	"last_seq" bigint NOT NULL,
	CONSTRAINT "change_seq_organisation_project_unique" UNIQUE NULLS NOT DISTINCT("organisation_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_seq" ADD CONSTRAINT "change_seq_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_seq" ADD CONSTRAINT "change_seq_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_organisation_occurred_idx" ON "audit_event" USING btree ("organisation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "change_event_entity_idx" ON "change_event" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE FUNCTION osfpm_reject_log_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_event_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "change_event"
FOR EACH STATEMENT EXECUTE FUNCTION osfpm_reject_log_change();
--> statement-breakpoint
CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_event"
FOR EACH STATEMENT EXECUTE FUNCTION osfpm_reject_log_change();
