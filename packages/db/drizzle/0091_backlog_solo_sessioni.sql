-- Backlog: solo sessioni di refinement (piano 2026-10-19-backlog-solo-sessioni).
-- Dismessi chat della voce (DOCS e CODE), domande a bottoni e deep dive: lo
-- storico si CANCELLA (irreversibile, decisione del maintainer). Gira tutta in
-- UNA transazione col resto del batch: nessun valore enum AGGIUNTO qui, solo un
-- tipo ricreato, quindi la trappola di CLAUDE.md non si applica.
--
-- 1. I job dismessi spariscono, anche `queued`/`running`: nessun worker nuovo
--    saprebbe eseguirli. `agent_sessions.backlog_job_id` è ON DELETE SET NULL.
DELETE FROM "backlog_jobs" WHERE "kind"::text IN ('deep_dive', 'chat_turn');--> statement-breakpoint
-- 2. Le sessioni il cui segmento attivo era un deep dive o un turno di chat:
--    l'etichetta esce da `agentSegmentLabelSchema`, e un segmento di quel tipo
--    non tornerà vivo. Stessa pulizia di `resetLiveSegments` (worker), ristretta
--    a queste righe, così la sessione resta coerente (nessun segmento attivo).
UPDATE "agent_sessions"
SET "active_segment_label" = NULL,
    "active_segment_id" = NULL,
    "active_segment_interactive" = false,
    "live_segment_ids" = '{}'
WHERE "active_segment_label" IN ('deep_dive', 'chat_turn');--> statement-breakpoint
-- 3. Le sessioni `backlog_item` non accettano più interventi: un intervento
--    rimasto `pending` non verrebbe mai consegnato, e non va perso in silenzio.
UPDATE "agent_session_inputs"
SET "status" = 'undelivered', "reason" = 'session_not_live'
WHERE "status" = 'pending'
  AND "session_id" IN (SELECT "id" FROM "agent_sessions" WHERE "kind" = 'backlog_item');--> statement-breakpoint
-- 4. Tabelle della chat, della sessione di analisi e delle domande a bottoni.
DROP TABLE "backlog_questions";--> statement-breakpoint
DROP TABLE "backlog_code_sessions";--> statement-breakpoint
DROP TABLE "backlog_chat_messages";--> statement-breakpoint
DROP TYPE "public"."backlog_code_session_status";--> statement-breakpoint
-- 5. `backlog_job_kind` ricreato coi soli valori rimasti, nell'ordine di
--    `backlogJobKindSchema` (enum-parity.test.ts). La colonna non ha default, e
--    l'unico indice di `backlog_jobs` filtra su `status`: il cambio di tipo non
--    tocca altro.
ALTER TYPE "public"."backlog_job_kind" RENAME TO "backlog_job_kind_old";--> statement-breakpoint
CREATE TYPE "public"."backlog_job_kind" AS ENUM('intake', 'estimate');--> statement-breakpoint
ALTER TABLE "backlog_jobs" ALTER COLUMN "kind" TYPE "public"."backlog_job_kind" USING "kind"::text::"public"."backlog_job_kind";--> statement-breakpoint
DROP TYPE "public"."backlog_job_kind_old";
