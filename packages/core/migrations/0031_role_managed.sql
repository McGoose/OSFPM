ALTER TABLE "role" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Hand-written: a managed role (role.managed) is one the server makes and keeps,
-- the Administrator role (SC-10, decision D-56). Only the server may make one,
-- change or delete it, or give, change or take away its grants; an organisation
-- never can, by whatever path its write takes. The service guards
-- (assertRoleEditable, assertGrantEditable) give a caller a clear error first, and
-- the triggers below are what is left when a caller skipped them. The server's own
-- writes switch the checks off for their transaction with
-- set_config('osfpm.managed_role_maintenance', 'on', true), which
-- withManagedRoleMaintenance does and which ends with the transaction. This
-- function is the one place that setting is read: it is missing or empty the rest
-- of the time, and anything but 'on' counts as off. It guards against a mistake in
-- the server's own code, not against someone who can run SQL as the application's
-- database role.
CREATE FUNCTION osfpm_managed_role_maintenance() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('osfpm.managed_role_maintenance', true), '') = 'on'
$$;
--> statement-breakpoint
-- Hand-written: only the server makes a managed role. The WHEN clause leaves the
-- function out for the server's own writes, so they pay nothing. Messages in this
-- migration carry no row values.
CREATE FUNCTION osfpm_role_managed_system_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'role_managed_system_only: only the server makes a managed role'
    USING ERRCODE = '23514', CONSTRAINT = 'role_managed_system_only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_managed_system_only
BEFORE INSERT ON "role"
FOR EACH ROW
WHEN (NEW.managed AND NOT osfpm_managed_role_maintenance())
EXECUTE FUNCTION osfpm_role_managed_system_only();
--> statement-breakpoint
-- Hand-written: a managed role cannot be changed in any column, a rename or a soft
-- delete included, and cannot be deleted. It cannot be made ordinary, and an
-- ordinary role cannot be made managed, so the flag is as fixed as the rest: the
-- WHEN clause fires when the role is managed before the change or after it.
CREATE FUNCTION osfpm_role_managed_no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'role_managed_no_change: a managed role cannot be changed or deleted'
    USING ERRCODE = '23514', CONSTRAINT = 'role_managed_no_change';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_managed_no_update
BEFORE UPDATE ON "role"
FOR EACH ROW
WHEN ((OLD.managed OR NEW.managed) AND NOT osfpm_managed_role_maintenance())
EXECUTE FUNCTION osfpm_role_managed_no_change();
--> statement-breakpoint
CREATE TRIGGER role_managed_no_delete
BEFORE DELETE ON "role"
FOR EACH ROW
WHEN (OLD.managed AND NOT osfpm_managed_role_maintenance())
EXECUTE FUNCTION osfpm_role_managed_no_change();
--> statement-breakpoint
-- Hand-written: the grants of a managed role cannot be added, changed or taken
-- away, and a grant cannot be moved onto or off a managed role. A CHECK cannot
-- read the role table, so a trigger looks up the role a grant belongs to: the one
-- it is going to, for an insert or an update (NEW), and the one it came from, for
-- an update or a delete (OLD). The role row is locked FOR SHARE, as the
-- all-projects triggers above do, so the flag read here is the one the row has
-- when this transaction commits. Every writer takes the organisation's change
-- counter before it reaches this trigger, so that lock is never taken in the
-- opposite order to a writer of the role.
CREATE FUNCTION osfpm_role_permission_managed_no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_is_managed boolean;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT r.managed INTO role_is_managed
    FROM "role" r
    WHERE r.organisation_id = NEW.organisation_id AND r.id = NEW.role_id
    FOR SHARE;
    IF FOUND AND role_is_managed THEN
      RAISE EXCEPTION 'role_permission_managed_no_change: the permissions of a managed role cannot be changed'
        USING ERRCODE = '23514', CONSTRAINT = 'role_permission_managed_no_change';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT r.managed INTO role_is_managed
    FROM "role" r
    WHERE r.organisation_id = OLD.organisation_id AND r.id = OLD.role_id
    FOR SHARE;
    IF FOUND AND role_is_managed THEN
      RAISE EXCEPTION 'role_permission_managed_no_change: the permissions of a managed role cannot be changed'
        USING ERRCODE = '23514', CONSTRAINT = 'role_permission_managed_no_change';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_permission_managed_no_change
BEFORE INSERT OR UPDATE OR DELETE ON "role_permission"
FOR EACH ROW
WHEN (NOT osfpm_managed_role_maintenance())
EXECUTE FUNCTION osfpm_role_permission_managed_no_change();
