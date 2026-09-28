CREATE TABLE "saml_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"organization_id" uuid,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"given_name" text,
	"family_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saml_requests" ADD CONSTRAINT "saml_requests_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saml_assertions_expires_at_idx" ON "saml_assertions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "saml_requests_expires_at_idx" ON "saml_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_user_name_unique" ON "scim_users" USING btree (lower("user_name"));