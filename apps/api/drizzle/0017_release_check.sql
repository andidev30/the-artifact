CREATE TABLE "release_check" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"latest_version" text,
	"release_url" text
);
