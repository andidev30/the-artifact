-- Page content has lived in object storage since 0008; the server moved older content there on
-- start. Stop instead of dropping content that was never moved (an install upgrading straight
-- from before 0008): start the release with 0008 once, let it move the content, then upgrade.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "artifact_versions" WHERE "html" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "artifact_files" WHERE "content" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "artifact_thumbnails" WHERE "image" IS NOT NULL) THEN
    RAISE EXCEPTION 'Some page content is still in the database. Start the previous release once so it moves the content to object storage, then upgrade.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "artifact_files" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "artifact_thumbnails" DROP COLUMN "image";--> statement-breakpoint
ALTER TABLE "artifact_versions" DROP COLUMN "html";
