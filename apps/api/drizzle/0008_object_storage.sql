-- Page content moves to object storage, keyed by its SHA-256. The hashes are computed here from the
-- content already in the database; the server then uploads that content and empties these columns
-- on start (src/storage-move.ts).
ALTER TABLE "artifact_files" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "html" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_thumbnails" ADD COLUMN "sha256" text;--> statement-breakpoint
UPDATE "artifact_thumbnails" SET "sha256" = encode(sha256("image"), 'hex') WHERE "image" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "html_sha256" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "html_size" integer;--> statement-breakpoint
UPDATE "artifact_versions" SET "html_sha256" = encode(sha256(convert_to("html", 'UTF8')), 'hex'), "html_size" = octet_length(convert_to("html", 'UTF8'));--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "html_sha256" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "html_size" SET NOT NULL;
