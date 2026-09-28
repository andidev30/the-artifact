CREATE TYPE "public"."sso_protocol" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "sso_protocol" NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"secret" text,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"organization_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_identities_subject_unique" ON "sso_identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE INDEX "sso_identities_user_idx" ON "sso_identities" USING btree ("user_id");