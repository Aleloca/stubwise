-- Pulse proattivo (fase 2): un poller rileva i progetti fermi e manda una
-- notifica azionabile con 2–3 proposte prese dal backlog. La cadenza è
-- per-progetto e l'invio è idempotente grazie a `pulse_last_sent_at`,
-- aggiornato con UPDATE condizionato nella stessa transazione della notifica.
-- ⚠️ 'project.pulse' NON va usato da nessun altro statement di questa
-- migrazione: il migratore esegue l'intero batch in UNA transazione e Postgres
-- non ammette l'uso di un valore enum aggiunto nella stessa.
ALTER TYPE "public"."notification_kind" ADD VALUE 'project.pulse';--> statement-breakpoint
-- Toggle del webhook d'istanza per il kind nuovo.
ALTER TABLE "notification_settings" ADD COLUMN "notify_pulse" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Attivazione per progetto (default off: al deploy nessun progetto riceve il
-- pulse), cadenza in giorni e istante dell'ultimo ping inviato (null = mai).
ALTER TABLE "projects" ADD COLUMN "pulse_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pulse_every_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pulse_last_sent_at" timestamp with time zone;--> statement-breakpoint
-- Sotto 1 giorno il pulse diventerebbe un ping continuo, sopra 30 un promemoria
-- che non arriva mai: la cadenza resta dentro la finestra utile.
ALTER TABLE "projects" ADD CONSTRAINT "projects_pulse_every_days_chk" CHECK (pulse_every_days BETWEEN 1 AND 30);
