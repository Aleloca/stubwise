-- Area 6, F4, task 0: i dati per scrivere sul calendario (vedi lo schema).
ALTER TABLE "calendar_events" ADD COLUMN "etag" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "ical_uid" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "visibility" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "organizer_self" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "calendar_events_ical_uid_idx" ON "calendar_events" USING btree ("ical_uid");
