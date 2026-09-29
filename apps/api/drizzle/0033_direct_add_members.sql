ALTER TABLE "memberships" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "added_notice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;