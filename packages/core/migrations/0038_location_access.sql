-- Structured location access (decision D-69, P-02l2): five yes, no or unknown answers, the
-- details that only make sense under a yes, and who verified the answers and when. An existing
-- location gets unknown for the five answers and nothing for the rest, because nobody has
-- described or verified it: no data is changed. Every statement below is the one drizzle
-- generated; this comment is the only hand-written part of the file.
ALTER TABLE "location" ADD COLUMN "step_free_route" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "accessible_toilet" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "accessible_toilet_distance_m" integer;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "accessible_parking" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "accessible_parking_surface" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "parking_height_clearance_cm" integer;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "quiet_room" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "seating" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "access_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "access_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_access_verified_by_fk" FOREIGN KEY ("access_verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_step_free_route_check" CHECK ("location"."step_free_route" in ('yes', 'no', 'unknown'));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_accessible_toilet_check" CHECK ("location"."accessible_toilet" in ('yes', 'no', 'unknown'));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_accessible_parking_check" CHECK ("location"."accessible_parking" in ('yes', 'no', 'unknown'));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_quiet_room_check" CHECK ("location"."quiet_room" in ('yes', 'no', 'unknown'));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_seating_check" CHECK ("location"."seating" in ('yes', 'no', 'unknown'));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_toilet_distance_check" CHECK ("location"."accessible_toilet_distance_m" is null or ("location"."accessible_toilet" = 'yes' and "location"."accessible_toilet_distance_m" between 0 and 5000));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_parking_surface_check" CHECK ("location"."accessible_parking_surface" is null or ("location"."accessible_parking" = 'yes' and "location"."accessible_parking_surface" in ('paved', 'gravel', 'grass', 'other')));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_parking_clearance_check" CHECK ("location"."parking_height_clearance_cm" is null or ("location"."accessible_parking" = 'yes' and "location"."parking_height_clearance_cm" between 100 and 500));--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_access_verified_check" CHECK (("location"."access_verified_at" is null) = ("location"."access_verified_by" is null));