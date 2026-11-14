ALTER TABLE "department" RENAME CONSTRAINT "department_organisation_id_organisation_id_fk" TO "department_organisation_fk";
--> statement-breakpoint
ALTER TABLE "org_membership" RENAME CONSTRAINT "org_membership_organisation_id_organisation_id_fk" TO "org_membership_organisation_fk";
--> statement-breakpoint
ALTER TABLE "organisation" RENAME CONSTRAINT "organisation_organisation_id_organisation_id_fk" TO "organisation_organisation_fk";
--> statement-breakpoint
ALTER TABLE "project_membership_role" RENAME CONSTRAINT "project_membership_role_organisation_id_organisation_id_fk" TO "project_membership_role_organisation_fk";
--> statement-breakpoint
ALTER TABLE "project_membership" RENAME CONSTRAINT "project_membership_organisation_id_organisation_id_fk" TO "project_membership_organisation_fk";
--> statement-breakpoint
ALTER TABLE "project" RENAME CONSTRAINT "project_organisation_id_organisation_id_fk" TO "project_organisation_fk";
--> statement-breakpoint
ALTER TABLE "role_permission" RENAME CONSTRAINT "role_permission_organisation_id_organisation_id_fk" TO "role_permission_organisation_fk";
--> statement-breakpoint
ALTER TABLE "role" RENAME CONSTRAINT "role_organisation_id_organisation_id_fk" TO "role_organisation_fk";
--> statement-breakpoint
ALTER TABLE "setting_value" RENAME CONSTRAINT "setting_value_organisation_id_organisation_id_fk" TO "setting_value_organisation_fk";
