CREATE TABLE "artifact_search" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"words" "tsvector" NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_tags" (
	"artifact_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_tags_artifact_id_tag_pk" PRIMARY KEY("artifact_id","tag")
);
--> statement-breakpoint
ALTER TABLE "artifact_search" ADD CONSTRAINT "artifact_search_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_search" ADD CONSTRAINT "artifact_search_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_tags" ADD CONSTRAINT "artifact_tags_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_search_words_idx" ON "artifact_search" USING gin ("words");--> statement-breakpoint
CREATE INDEX "artifact_tags_tag_idx" ON "artifact_tags" USING btree ("tag","artifact_id");