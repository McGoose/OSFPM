ALTER TABLE "setup_code" ALTER COLUMN "retention_class" SET DEFAULT 'transient';
--> statement-breakpoint
-- Hand-written: setup codes written before this migration still hold
-- security-log, the old default. Move them to transient, as 0027 did for
-- sessions and login challenges, so a row's class does not depend on when it
-- was written. Only rows still on the old default move. It changes the class of
-- existing rows and nothing else: no code is used, revoked or issued. Drizzle
-- does not generate data changes.
UPDATE "setup_code" SET "retention_class" = 'transient' WHERE "retention_class" = 'security-log';
