CREATE TABLE "artifact_view_counts" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"views" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_view_counts" ADD CONSTRAINT "artifact_view_counts_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_views" ADD CONSTRAINT "artifact_views_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_views" ADD CONSTRAINT "artifact_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_views_artifact_user_idx" ON "artifact_views" USING btree ("artifact_id","user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "artifact_views_viewed_at_idx" ON "artifact_views" USING btree ("viewed_at");