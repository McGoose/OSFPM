ALTER TABLE "user_access_profile" ALTER COLUMN "retention_class" SET DEFAULT 'account-lifetime';
--> statement-breakpoint
-- Hand-written: add the retention class that access profiles now default to. The
-- classes are rows seeded by migration (0013 seeded the first ones) and drizzle does
-- not generate rows. A profile belongs to an account, not to a production, so the
-- class has no period: its rows are kept while the account exists and are deleted
-- with it or when the person deletes the profile (decision D-69, maintainer decision
-- P-02l1). The anchor list is fixed and has no "never"; record-created is the one
-- that names no project, so no wrap, delivery or exploitation date can ever count
-- for it, and with no period nothing ends it. It comes before the update below,
-- whose foreign key needs it.
INSERT INTO "retention_class" ("key", "description", "anchor") VALUES
	('account-lifetime', 'Kept while the account exists; deleted with the account or when the person deletes it', 'record-created');
--> statement-breakpoint
-- Hand-written: profiles written before this migration still hold crew-health, the
-- old default, whose anchor is the project wrap. Move them to account-lifetime so a
-- profile's class does not depend on when it was written. Only rows still on the old
-- default move. Grants (access_grant) are not touched: they stay crew-health, the
-- class of the data a production sees. This changes metadata only (the retention
-- class), never security state, so it writes no audit event. Drizzle does not
-- generate data changes.
UPDATE "user_access_profile" SET "retention_class" = 'account-lifetime' WHERE "retention_class" = 'crew-health';
