CREATE TABLE "artifact_files" (
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "artifact_files_version_id_path_pk" PRIMARY KEY("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "artifact_thumbnails" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"image" "bytea",
	"content_type" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_thumbnails" ADD CONSTRAINT "artifact_thumbnails_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;