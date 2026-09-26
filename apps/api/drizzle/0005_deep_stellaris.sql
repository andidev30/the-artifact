ALTER TABLE "artifact_versions" ADD COLUMN "published_with" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "restored_from" integer;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;