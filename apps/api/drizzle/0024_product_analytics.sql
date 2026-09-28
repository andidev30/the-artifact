CREATE TABLE "product_daily_counts" (
	"day" date NOT NULL,
	"event" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_daily_counts_day_event_pk" PRIMARY KEY("day","event")
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_events_user_event_unique" ON "product_events" USING btree ("user_id","event");--> statement-breakpoint
CREATE INDEX "product_events_event_created_at_idx" ON "product_events" USING btree ("event","created_at");