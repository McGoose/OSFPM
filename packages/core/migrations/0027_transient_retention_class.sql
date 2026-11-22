ALTER TABLE "login_challenge" ALTER COLUMN "retention_class" SET DEFAULT 'transient';--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "retention_class" SET DEFAULT 'transient';
--> statement-breakpoint
-- Hand-written: add the retention class that sessions and login challenges now
-- default to. The classes are rows seeded by migration (0013 seeded the first
-- ones) and drizzle does not generate rows. The class has no period: its rows
-- are working rows that cleanup removes, and the audit log is the record
-- (maintainer decision, P-03b3a). It comes before the updates below, whose
-- foreign key needs it.
INSERT INTO "retention_class" ("key", "description", "anchor") VALUES
	('transient', 'Working rows removed by cleanup; the audit log is the record', 'record-created');
--> statement-breakpoint
-- Hand-written: sessions and login challenges written before this migration
-- still hold security-log, the old default. Move them to transient so a row's
-- class does not depend on when it was written. Only rows still on the old
-- default move, and no other table is touched. Drizzle does not generate data
-- changes.
UPDATE "session" SET "retention_class" = 'transient' WHERE "retention_class" = 'security-log';
--> statement-breakpoint
UPDATE "login_challenge" SET "retention_class" = 'transient' WHERE "retention_class" = 'security-log';
