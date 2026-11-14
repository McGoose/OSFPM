UPDATE "block" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "block" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "block" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "company" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "department" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "department" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "department" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "episode" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "episode" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "episode" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "location" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "location" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "location" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "org_membership" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "org_membership" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "org_membership" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "organisation" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "organisation" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "organisation" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "person_company" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "person_company" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "person_company" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "person_sensitive" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "person_sensitive" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "person_sensitive" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "person" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "person" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "person" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project_company" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project_company" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project_company" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project_location" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project_location" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project_location" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project_membership_role" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project_membership_role" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project_membership_role" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project_membership" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project_membership" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project_membership" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project_person" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project_person" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project_person" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "project" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "role_permission" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "role_permission" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "role_permission" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "role" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "role" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "role" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "setting_value" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "setting_value" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "setting_value" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "unit" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
UPDATE "user" SET "retention_class" = 'standard' WHERE "retention_class" IS NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "retention_class" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "retention_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive" ADD CONSTRAINT "person_sensitive_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership_role" ADD CONSTRAINT "project_membership_role_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_value" ADD CONSTRAINT "setting_value_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;