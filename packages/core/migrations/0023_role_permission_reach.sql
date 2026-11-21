ALTER TABLE "role_permission" ADD COLUMN "reach" text DEFAULT 'own-scope' NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_reach_check" CHECK ("role_permission"."reach" in ('own-scope', 'all-projects'));--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_all_projects_no_department_check" CHECK ("role_permission"."reach" = 'own-scope' or "role_permission"."department_id" is null);
--> statement-breakpoint
-- Hand-written: an all-projects grant (role_permission.reach) is only for an
-- organisation role (role.project_id IS NULL). A project role already applies
-- on its own project, and a CHECK cannot read the role table. The role row is
-- locked FOR SHARE so a concurrent change of that role to a project role waits
-- for this transaction. The trigger fires only for all-projects rows, so the
-- common own-scope write takes no extra lock. Messages carry no row values.
CREATE FUNCTION osfpm_role_permission_all_projects_org_role_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  granted_project_id uuid;
BEGIN
  SELECT r.project_id INTO granted_project_id
  FROM "role" r
  WHERE r.organisation_id = NEW.organisation_id AND r.id = NEW.role_id
  FOR SHARE;
  IF FOUND AND granted_project_id IS NOT NULL THEN
    RAISE EXCEPTION 'role_permission_all_projects_org_role_only: only an organisation role can hold an all-projects grant'
      USING ERRCODE = '23514', CONSTRAINT = 'role_permission_all_projects_org_role_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_permission_all_projects_org_role_only
BEFORE INSERT OR UPDATE ON "role_permission"
FOR EACH ROW
WHEN (NEW.reach = 'all-projects')
EXECUTE FUNCTION osfpm_role_permission_all_projects_org_role_only();
--> statement-breakpoint
-- Hand-written: the other side of the same rule. A role that any all-projects
-- grant references, deleted grants included (a restore must stay valid), cannot
-- be made a project role. The role row is already locked by the UPDATE that
-- fires this trigger, and a writer of an all-projects grant locks it FOR SHARE,
-- so a grant being written at the same moment makes the update wait and then
-- see it.
CREATE FUNCTION osfpm_role_keep_org_role_for_all_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "role_permission" rp
    WHERE rp.organisation_id = NEW.organisation_id
      AND rp.role_id = NEW.id
      AND rp.reach = 'all-projects'
  ) THEN
    RAISE EXCEPTION 'role_permission_all_projects_org_role_only: a role with all-projects grants cannot become a project role'
      USING ERRCODE = '23514', CONSTRAINT = 'role_permission_all_projects_org_role_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_keep_org_role_for_all_projects
BEFORE UPDATE OF project_id ON "role"
FOR EACH ROW
WHEN (NEW.project_id IS NOT NULL AND OLD.project_id IS DISTINCT FROM NEW.project_id)
EXECUTE FUNCTION osfpm_role_keep_org_role_for_all_projects();
--> statement-breakpoint
-- Hand-written: a permission with grants_sensitive = true can never be reached
-- into all projects (CLAUDE.md, Privacy rule; maintainer decision of 21 Nov,
-- P-02k). The sensitive flag lives on another table, so a CHECK cannot see it.
-- The permission row is locked FOR SHARE so a concurrent change of its flag
-- waits for this transaction. Fires only for all-projects rows. Messages carry
-- no row values.
CREATE FUNCTION osfpm_role_permission_all_projects_not_sensitive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_sensitive boolean;
BEGIN
  SELECT p.grants_sensitive INTO is_sensitive
  FROM "permission" p
  WHERE p.key = NEW.permission_key
  FOR SHARE;
  IF FOUND AND is_sensitive THEN
    RAISE EXCEPTION 'role_permission_all_projects_not_sensitive: a sensitive permission cannot be granted to all projects'
      USING ERRCODE = '23514', CONSTRAINT = 'role_permission_all_projects_not_sensitive';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_permission_all_projects_not_sensitive
BEFORE INSERT OR UPDATE ON "role_permission"
FOR EACH ROW
WHEN (NEW.reach = 'all-projects')
EXECUTE FUNCTION osfpm_role_permission_all_projects_not_sensitive();
--> statement-breakpoint
-- Hand-written: the other side of the same rule. A permission that any
-- all-projects grant references, deleted grants included, cannot be flagged
-- sensitive. The permission row is already locked by the UPDATE that fires this
-- trigger, and a writer of an all-projects grant locks it FOR SHARE. The
-- upsert in syncPermissions reaches this trigger too, since it updates the flag.
CREATE FUNCTION osfpm_permission_keep_non_sensitive_for_all_projects() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "role_permission" rp
    WHERE rp.permission_key = NEW.key
      AND rp.reach = 'all-projects'
  ) THEN
    RAISE EXCEPTION 'role_permission_all_projects_not_sensitive: a permission with all-projects grants cannot become sensitive'
      USING ERRCODE = '23514', CONSTRAINT = 'role_permission_all_projects_not_sensitive';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER permission_keep_non_sensitive_for_all_projects
BEFORE UPDATE OF grants_sensitive ON "permission"
FOR EACH ROW
WHEN (NEW.grants_sensitive AND NOT OLD.grants_sensitive)
EXECUTE FUNCTION osfpm_permission_keep_non_sensitive_for_all_projects();
