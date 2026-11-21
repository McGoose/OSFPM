-- Hand-written: a cost line stores its amount in the project's currency
-- (amount_project_currency), worked out when the line was written. Changing the
-- project's currency afterwards would leave every such amount in the old
-- currency, with nothing to say so, and a CHECK cannot read another table. So
-- the currency of a project with live cost lines cannot change; removed lines
-- do not count. The project row is already locked by the UPDATE that fires this
-- trigger, and the cost line service reads the project FOR SHARE before it
-- prices a line, so a line being written at the same moment makes the update
-- wait and then see it. Messages carry no row values.
CREATE FUNCTION osfpm_project_currency_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "cost_line" c
    WHERE c.organisation_id = OLD.organisation_id
      AND c.project_id = OLD.id
      AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'project_currency_locked: the currency of a project with live cost lines cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'project_currency_locked';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_currency_locked
BEFORE UPDATE OF currency ON "project"
FOR EACH ROW
WHEN (OLD.currency IS DISTINCT FROM NEW.currency)
EXECUTE FUNCTION osfpm_project_currency_locked();
