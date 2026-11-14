-- Area 8, fetta 4a: i server nell'app (monitor e ambienti).
-- Il codice dei server (`SRV-<n>`, F4a-2 = a): un numero d'ISTANZA da una
-- sequenza, mai riusato. I server di prima numerati per data di creazione
-- (e id).
ALTER TABLE "servers" ADD COLUMN "number" integer;
--> statement-breakpoint
UPDATE "servers" s SET "number" = r."n"
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "n" FROM "servers") r
WHERE r."id" = s."id";
--> statement-breakpoint
CREATE SEQUENCE "servers_number_seq" OWNED BY "servers"."number";
--> statement-breakpoint
SELECT setval('servers_number_seq', coalesce((SELECT max("number") FROM "servers"), 0) + 1, false);
--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "number" SET DEFAULT nextval('servers_number_seq');
--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_number_unique" UNIQUE ("number");
--> statement-breakpoint
-- Gli episodi (F4a-3 = a): dall'allarme al rientro, uno aperto per server;
-- un secondo allarme durante si aggiunge ai motivi. Li scrive il worker degli
-- avvisi; la F4b ci attacca l'analisi.
CREATE TABLE "server_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"severity" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recovered_at" timestamp with time zone,
	CONSTRAINT "server_episodes_severity_chk" CHECK ("severity" in ('trouble', 'down'))
);
--> statement-breakpoint
CREATE INDEX "server_episodes_server_idx" ON "server_episodes" USING btree ("server_id", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "server_episodes_open_idx" ON "server_episodes" USING btree ("server_id") WHERE "recovered_at" IS NULL;
--> statement-breakpoint
-- `monitor.view` esce dal preset `User` (F4a-1 = a): un utente vede i server
-- dei suoi progetti, dagli ambienti. SOLO dal preset (46): i ruoli
-- personalizzati non si toccano, li elenca il deploy-log.
UPDATE "roles" SET "permissions" = array_remove("permissions", 'monitor.view') WHERE "preset_key" = 'user';
