CREATE TABLE "auto_joins" (
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"notice_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_joins_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_join_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_join_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "auto_join_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auto_joins" ADD CONSTRAINT "auto_joins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_joins" ADD CONSTRAINT "auto_joins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_joins_org_idx" ON "auto_joins" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_auto_join_organization_id_organizations_id_fk" FOREIGN KEY ("auto_join_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;