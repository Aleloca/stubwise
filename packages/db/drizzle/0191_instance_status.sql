-- Area 9, F4 (D-7 = a): lo Stato dell'istanza.
-- La pausa della coda di un progetto: in pausa, i poller del worker non
-- reclamano lavoro NUOVO di Claude di quel progetto (la WHERE del claim di ogni
-- coda); il lavoro partito finisce; chat e «Chiedi a Claude» non si fermano.
-- Agisce solo sulla coda di Stubwise: nessun server, ambiente o processo.
ALTER TABLE "projects" ADD COLUMN "queue_paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "queue_paused_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_queue_paused_by_user_id_users_id_fk" FOREIGN KEY ("queue_paused_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- L'heartbeat dei worker: una riga per processo, riscritta a ogni giro (J-2 = a:
-- coi lavori che ha in mano). Le righe vecchie le pota il worker.
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concurrency" integer NOT NULL,
	"running" jsonb DEFAULT '[]'::jsonb NOT NULL
);
