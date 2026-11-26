-- Area 9, F6 (D-8): eliminare un repository staccato toglie dal volume anche
-- il suo codice (il mirror, se nessun altro repository usa quell'URL) e il suo
-- grafo. Lo fa il worker, unico scrittore di mirror e grafi, con un job
-- `prune` sulla coda dei grafi accodato nella transazione del DELETE. Il job
-- sopravvive al repository: niente FK in cascata (gli altri job del
-- repository li toglie il DELETE), e l'URL viaggia nel job.
ALTER TABLE "graph_jobs" DROP CONSTRAINT "graph_jobs_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "graph_jobs" ADD COLUMN "repo_url" text;
