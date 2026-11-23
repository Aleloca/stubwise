-- Rimandi, lotto 4 (A8, lo stato «scartata» di una correzione): come si è
-- chiusa una correzione `done`. `discarded` = push rifiutato perché qualcuno
-- ha pushato sul branch nel frattempo (non conta nel tetto dei giri). Null per
-- le `cancelled` e per le righe di prima: la lettura ricade sul job.
ALTER TABLE "pr_corrections" ADD COLUMN "outcome" text;
--> statement-breakpoint
ALTER TABLE "pr_corrections" ADD CONSTRAINT "pr_corrections_outcome_chk" CHECK (outcome IS NULL OR outcome IN ('pushed', 'discarded', 'stopped'));
--> statement-breakpoint
-- Le scartate di prima: il worker scriveva questa frase come errore del job.
UPDATE "pr_corrections" c SET "outcome" = 'discarded' FROM "ai_jobs" j
WHERE j."correction_id" = c."id" AND c."status" = 'done' AND j."status" = 'failed' AND j."error" LIKE 'push rifiutato:%';
