CREATE TYPE "public"."share_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TABLE "artifact_shares" (
	"artifact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "share_role" NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_shares_artifact_id_email_pk" PRIMARY KEY("artifact_id","email")
);
--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_shares" ADD CONSTRAINT "artifact_shares_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_shares_email_idx" ON "artifact_shares" USING btree ("email");