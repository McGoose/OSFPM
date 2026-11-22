ALTER TABLE "session" ADD COLUMN "passkey_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_passkey_credential_fk" FOREIGN KEY ("passkey_credential_id") REFERENCES "public"."passkey_credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_passkey_credential_idx" ON "session" USING btree ("passkey_credential_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_passkey_credential_check" CHECK ("session"."passkey_credential_id" is null or "session"."method" = 'passkey');