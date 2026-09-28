CREATE TABLE "rate_limits" (
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"hits" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limits_bucket_key_pk" PRIMARY KEY("bucket","key")
);
--> statement-breakpoint
CREATE INDEX "rate_limits_resets_at_idx" ON "rate_limits" USING btree ("resets_at");