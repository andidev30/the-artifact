CREATE TABLE "issued_licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signing_key_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"seats" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_by" uuid
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "license_key" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "license_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "license_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD CONSTRAINT "issued_licenses_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issued_licenses_issued_at_idx" ON "issued_licenses" USING btree ("issued_at");--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_license_updated_by_users_id_fk" FOREIGN KEY ("license_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;