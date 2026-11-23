-- Revisione del lotto 2, I6: chi ha prodotto una run di CI (GitHub: la check
-- suite; Bitbucket: la key dello status). Una run più nuova col nome uguale
-- prende il posto di quella di prima SOLO nello stesso gruppo: due job
-- omonimi di workflow diversi sono due run. Null = salvata prima.
ALTER TABLE "release_ci_runs" ADD COLUMN "run_group" text;
