CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"owner_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_one_workspace" CHECK (("folders"."organization_id" is null) <> ("folders"."owner_id" is null))
);
--> statement-breakpoint
DROP INDEX "artifacts_owner_idx";--> statement-breakpoint
DROP INDEX "artifacts_org_idx";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_org_name_unique" ON "folders" USING btree ("organization_id",lower("name")) WHERE "folders"."organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_owner_name_unique" ON "folders" USING btree ("owner_id",lower("name")) WHERE "folders"."organization_id" is null;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_folder_idx" ON "artifacts" USING btree ("folder_id","updated_at","id");--> statement-breakpoint
-- Makes title search (ILIKE '%term%') an index lookup. pg_trgm ships with Postgres (contrib) and is a
-- trusted extension since Postgres 13, so the database owner can create it. Where it can't be created,
-- the upgrade goes on without the index: search still works, it just scans the workspace's pages.
DO $$
BEGIN
	CREATE EXTENSION IF NOT EXISTS pg_trgm;
	CREATE INDEX IF NOT EXISTS "artifacts_title_trgm_idx" ON "artifacts" USING gin ("title" gin_trgm_ops);
EXCEPTION WHEN others THEN
	RAISE NOTICE 'pg_trgm is not available (%), so page titles are searched without an index', SQLERRM;
END $$;--> statement-breakpoint
CREATE INDEX "artifacts_owner_idx" ON "artifacts" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "artifacts_org_idx" ON "artifacts" USING btree ("organization_id","updated_at","id");