-- Hand-written: the sensitive scope of a personal API token lists permission keys, and
-- no key may be listed twice (api_token_sensitive_permissions_distinct_check, SC-10,
-- decision D-68). A CHECK cannot hold a subquery, so the test for a repeated key is
-- this function, which the CHECK calls. It is IMMUTABLE because it reads nothing but
-- its argument. An empty list passes, and so does one with each key once; a list with
-- a key twice or with an empty entry (NULL) does not, because DISTINCT counts no NULL.
-- It must exist before the table, which is why it comes first, and drizzle's snapshot
-- does not track it.
CREATE FUNCTION osfpm_text_array_is_distinct(items text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(items) = (SELECT count(DISTINCT item) FROM unnest(items) AS item)
$$;
--> statement-breakpoint
CREATE TABLE "api_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"retention_class" text DEFAULT 'transient' NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"access" text NOT NULL,
	"sensitive_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "api_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_token_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "api_token_access_check" CHECK ("api_token"."access" in ('read', 'write')),
	CONSTRAINT "api_token_name_check" CHECK (char_length("api_token"."name") between 1 and 100),
	CONSTRAINT "api_token_expiry_check" CHECK ("api_token"."expires_at" is null or "api_token"."expires_at" > "api_token"."created_at"),
	CONSTRAINT "api_token_revoked_pair_check" CHECK (("api_token"."revoked_at" is null) = ("api_token"."revoke_reason" is null)),
	CONSTRAINT "api_token_revoke_reason_check" CHECK ("api_token"."revoke_reason" is null or "api_token"."revoke_reason" in ('manual', 'switch-off', 'access-reset', 'membership-ended')),
	CONSTRAINT "api_token_revoker_check" CHECK ("api_token"."revoked_by" is null or "api_token"."revoked_at" is not null),
	CONSTRAINT "api_token_manual_revoker_check" CHECK ("api_token"."revoke_reason" is distinct from 'manual' or "api_token"."revoked_by" is not null),
	CONSTRAINT "api_token_sensitive_permissions_distinct_check" CHECK (osfpm_text_array_is_distinct("api_token"."sensitive_permissions"))
);
--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_retention_class_fk" FOREIGN KEY ("retention_class") REFERENCES "public"."retention_class"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_org_membership_fk" FOREIGN KEY ("organisation_id","user_id") REFERENCES "public"."org_membership"("organisation_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_project_fk" FOREIGN KEY ("organisation_id","project_id") REFERENCES "public"."project"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_revoked_by_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_token_organisation_user_idx" ON "api_token" USING btree ("organisation_id","user_id");--> statement-breakpoint
CREATE INDEX "api_token_user_idx" ON "api_token" USING btree ("user_id");