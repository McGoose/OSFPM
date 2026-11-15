CREATE TABLE "org_membership_role" (
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
	"visibility" text DEFAULT 'private' NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "org_membership_role_membership_role_unique" UNIQUE("membership_id","role_id"),
	CONSTRAINT "org_membership_role_visibility_check" CHECK ("org_membership_role"."visibility" in ('private', 'project', 'shared-with-partners'))
);
--> statement-breakpoint
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_organisation_id_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_membership_fk" FOREIGN KEY ("organisation_id","membership_id") REFERENCES "public"."org_membership"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership_role" ADD CONSTRAINT "org_membership_role_role_fk" FOREIGN KEY ("organisation_id","role_id") REFERENCES "public"."role"("organisation_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
-- Only organisation roles (role.project_id IS NULL) may be linked to an
-- organisation membership. The role row is locked FOR SHARE so a concurrent
-- change of that role to a project role waits for this transaction. Messages
-- carry no row values.
CREATE FUNCTION osfpm_org_membership_role_org_role_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked_project_id uuid;
BEGIN
  SELECT r.project_id INTO linked_project_id
  FROM "role" r
  WHERE r.organisation_id = NEW.organisation_id AND r.id = NEW.role_id
  FOR SHARE;
  IF FOUND AND linked_project_id IS NOT NULL THEN
    RAISE EXCEPTION 'org_membership_role_org_role_only: only an organisation role can be linked to an organisation membership'
      USING ERRCODE = '23514', CONSTRAINT = 'org_membership_role_org_role_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER org_membership_role_org_role_only
BEFORE INSERT OR UPDATE ON "org_membership_role"
FOR EACH ROW EXECUTE FUNCTION osfpm_org_membership_role_org_role_only();
--> statement-breakpoint
-- The other side of the same rule: a role that any organisation membership
-- link references, deleted links included (a restore must stay valid), cannot
-- be made project-scoped.
CREATE FUNCTION osfpm_role_stay_org_role_when_linked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "org_membership_role" l
    WHERE l.organisation_id = NEW.organisation_id AND l.role_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'org_membership_role_org_role_only: a role linked to an organisation membership cannot become a project role'
      USING ERRCODE = '23514', CONSTRAINT = 'org_membership_role_org_role_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_stay_org_role_when_linked
BEFORE UPDATE OF project_id ON "role"
FOR EACH ROW
WHEN (NEW.project_id IS NOT NULL AND OLD.project_id IS DISTINCT FROM NEW.project_id)
EXECUTE FUNCTION osfpm_role_stay_org_role_when_linked();
