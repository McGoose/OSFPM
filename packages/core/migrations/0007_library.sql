CREATE TABLE "company" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"kind" text NOT NULL,
	"country" text,
	"vat_number" text,
	"registration_number" text,
	"address_line1" text,
	"address_line2" text,
	"address_city" text,
	"address_postcode" text,
	"address_region" text,
	"address_country" text,
	"email" text,
	"phone" text,
	"website" text,
	"is_related_party" boolean DEFAULT false NOT NULL,
	"related_party_note" text,
	CONSTRAINT "company_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "company_visibility_check" CHECK ("company"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "company_kind_check" CHECK ("company"."kind" in ('vendor', 'co-producer', 'agency', 'funder', 'broadcaster', 'distributor', 'rental-house', 'other')),
	CONSTRAINT "company_country_check" CHECK ("company"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "company_address_country_check" CHECK ("company"."address_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "company_email_lowercase_check" CHECK ("company"."email" is null or "company"."email" = lower("company"."email"))
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"address_city" text,
	"address_postcode" text,
	"address_region" text,
	"address_country" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"timezone" text,
	"owner_company_id" uuid,
	"contact_person_id" uuid,
	"access_notes" text,
	"parking_notes" text,
	"nearest_hospital_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "location_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "location_visibility_check" CHECK ("location"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "location_kind_check" CHECK ("location"."kind" in ('location', 'studio', 'stage', 'unit-base', 'parking', 'hospital', 'office', 'other')),
	CONSTRAINT "location_status_check" CHECK ("location"."status" in ('active', 'archived')),
	CONSTRAINT "location_address_country_check" CHECK ("location"."address_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "location_latitude_check" CHECK ("location"."latitude" between -90 and 90),
	CONSTRAINT "location_longitude_check" CHECK ("location"."longitude" between -180 and 180),
	CONSTRAINT "location_coordinates_pair_check" CHECK (("location"."latitude" is null) = ("location"."longitude" is null)),
	CONSTRAINT "location_nearest_hospital_self_check" CHECK ("location"."nearest_hospital_id" <> "location"."id")
);
--> statement-breakpoint
CREATE TABLE "person_company" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"person_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"start_date" date,
	"end_date" date,
	CONSTRAINT "person_company_link_unique" UNIQUE NULLS NOT DISTINCT("person_id","company_id","relation","start_date"),
	CONSTRAINT "person_company_visibility_check" CHECK ("person_company"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "person_company_relation_check" CHECK ("person_company"."relation" in ('employee', 'represented-by', 'owner', 'director', 'other')),
	CONSTRAINT "person_company_dates_check" CHECK ("person_company"."end_date" is null or "person_company"."start_date" is null or "person_company"."end_date" >= "person_company"."start_date")
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"legal_name" text,
	"credit_name" text,
	"pronouns" text,
	"email" text,
	"phone" text,
	"locale" text,
	"default_department_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "person_organisation_user_unique" UNIQUE("organisation_id","user_id"),
	CONSTRAINT "person_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "person_visibility_check" CHECK ("person"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "person_email_lowercase_check" CHECK ("person"."email" is null or "person"."email" = lower("person"."email")),
	CONSTRAINT "person_status_check" CHECK ("person"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "project_company" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'project' NOT NULL,
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "project_company_role_unique" UNIQUE("project_id","company_id","role"),
	CONSTRAINT "project_company_visibility_check" CHECK ("project_company"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "project_company_role_check" CHECK ("project_company"."role" in ('vendor', 'co-producer', 'funder', 'broadcaster', 'distributor', 'other')),
	CONSTRAINT "project_company_status_check" CHECK ("project_company"."status" in ('proposed', 'confirmed', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "project_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'project' NOT NULL,
	"project_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "project_location_unique" UNIQUE("project_id","location_id"),
	CONSTRAINT "project_location_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "project_location_visibility_check" CHECK ("project_location"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "project_location_status_check" CHECK ("project_location"."status" in ('scouted', 'proposed', 'approved', 'confirmed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "project_person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text,
	"organisation_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'project' NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"engagement" text NOT NULL,
	"department_id" uuid,
	"job_title" text,
	"character_name" text,
	"cast_number" integer,
	"start_date" date,
	"end_date" date,
	"status" text NOT NULL,
	CONSTRAINT "project_person_engagement_unique" UNIQUE NULLS NOT DISTINCT("project_id","person_id","engagement","character_name"),
	CONSTRAINT "project_person_organisation_id_id_unique" UNIQUE("organisation_id","id"),
	CONSTRAINT "project_person_visibility_check" CHECK ("project_person"."visibility" in ('private', 'project', 'shared-with-partners')),
	CONSTRAINT "project_person_engagement_check" CHECK ("project_person"."engagement" in ('crew', 'cast', 'background', 'contact')),
	CONSTRAINT "project_person_status_check" CHECK ("project_person"."status" in ('proposed', 'confirmed', 'released')),
	CONSTRAINT "project_person_cast_number_positive_check" CHECK ("project_person"."cast_number" is null or "project_person"."cast_number" > 0),
	CONSTRAINT "project_person_cast_number_cast_only_check" CHECK ("project_person"."cast_number" is null or "project_person"."engagement" = 'cast'),
	CONSTRAINT "project_person_dates_check" CHECK ("project_person"."end_date" is null or "project_person"."start_date" is null or "project_person"."end_date" >= "project_person"."start_date")
);
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_company_fk" FOREIGN KEY ("organisation_id","owner_company_id") REFERENCES "public"."company"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_person_fk" FOREIGN KEY ("organisation_id","contact_person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_nearest_hospital_fk" FOREIGN KEY ("organisation_id","nearest_hospital_id") REFERENCES "public"."location"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_company" ADD CONSTRAINT "person_company_company_fk" FOREIGN KEY ("organisation_id","company_id") REFERENCES "public"."company"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_department_fk" FOREIGN KEY ("organisation_id","default_department_id") REFERENCES "public"."department"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_company" ADD CONSTRAINT "project_company_company_fk" FOREIGN KEY ("organisation_id","company_id") REFERENCES "public"."company"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location" ADD CONSTRAINT "project_location_location_fk" FOREIGN KEY ("organisation_id","location_id") REFERENCES "public"."location"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_person_fk" FOREIGN KEY ("organisation_id","person_id") REFERENCES "public"."person"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_person" ADD CONSTRAINT "project_person_department_fk" FOREIGN KEY ("organisation_id","department_id") REFERENCES "public"."department"("organisation_id","id") ON DELETE no action ON UPDATE no action;