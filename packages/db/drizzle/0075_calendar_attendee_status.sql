-- Fase 9 — lo stato di risposta dei partecipanti e il link diretto
-- all'evento (design §3, Task 2). Additiva, nessun ALTER TYPE, un solo
-- batch — ma CON BACKFILL: non è cosmetica. In produzione ci sono 1553
-- righe in `calendar_events` con `attendees` come `text[]` di sole email;
-- il modello da imitare è la 0074 — la colonna nasce NULLABLE, il backfill
-- riempie, il NOT NULL arriva DOPO, così un buco nel backfill fa fallire la
-- migrazione (il server non parte) invece di lasciare dati muti.

-- Link diretto all'evento su Google Calendar: nessun backfill possibile
-- (Google non l'abbiamo mai salvato), resta NULL per le righe storiche.
ALTER TABLE "calendar_events" ADD COLUMN "html_link" text;--> statement-breakpoint

-- La colonna nuova nasce NULLABLE accanto alla vecchia: le due coesistono
-- solo per la durata di questa migrazione.
ALTER TABLE "calendar_events" ADD COLUMN "attendees_v2" jsonb;--> statement-breakpoint

-- Backfill: ogni email della vecchia colonna diventa un partecipante con
-- `responseStatus: null` — lo stato di risposta non è mai stato conservato,
-- quindi non è ricostruibile per le righe storiche, e null lo dice
-- onestamente invece di indovinare un valore. `COALESCE` copre anche le
-- righe con `attendees = '{}'` (il default precedente, non NULL): senza,
-- `jsonb_agg` su un `unnest` vuoto tornerebbe NULL e violerebbe il NOT NULL
-- sotto.
UPDATE "calendar_events"
SET "attendees_v2" = COALESCE(
  (
    SELECT jsonb_agg(jsonb_build_object('email', "a", 'responseStatus', NULL))
    FROM unnest("attendees") AS "a"
  ),
  '[]'::jsonb
);
--> statement-breakpoint

ALTER TABLE "calendar_events" ALTER COLUMN "attendees_v2" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "attendees_v2" SET DEFAULT '[]'::jsonb;--> statement-breakpoint

-- Via la colonna vecchia, e la nuova prende il suo nome: alla fine c'è UNA
-- sola fonte di verità per i partecipanti, non una colonna nuova accanto a
-- una vecchia (design §6).
ALTER TABLE "calendar_events" DROP COLUMN "attendees";--> statement-breakpoint
ALTER TABLE "calendar_events" RENAME COLUMN "attendees_v2" TO "attendees";
