CREATE TABLE "retention_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"keep_days" integer,
	"keep_versions" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_keep_days" CHECK ("retention_policies"."keep_days" is null or "retention_policies"."keep_days" > 0),
	CONSTRAINT "retention_policies_keep_versions" CHECK ("retention_policies"."keep_versions" is null or "retention_policies"."keep_versions" > 0)
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;