ALTER TABLE "artifact_shares" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD COLUMN "accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_token_hash_unique" UNIQUE("token_hash");