ALTER TABLE "artifacts" ADD COLUMN "link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "link_password_hash" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "link_token" text;