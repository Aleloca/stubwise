-- Rimandi, lotto 4 (pulizia punto 5): lo stato della PR di setup del grafo.
-- La scrive il worker quando la apre (`open`) e il webhook quando la PR si
-- chiude, si mergia o si riapre. null = non si sa (una PR aperta prima di
-- questa colonna, o nessuna PR).
ALTER TABLE "repo_graphs" ADD COLUMN "setup_pr_state" text;
--> statement-breakpoint
ALTER TABLE "repo_graphs" ADD CONSTRAINT "repo_graphs_setup_pr_state_chk" CHECK (setup_pr_state IS NULL OR setup_pr_state IN ('open', 'merged', 'closed_unmerged'));
