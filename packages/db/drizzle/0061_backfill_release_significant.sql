-- Backfill significant per le release esistenti dal prefisso "[minore]" nel titolo.
-- Le release NON minori (senza prefisso) diventano significant=true.
UPDATE "doc_pages"
SET "significant" = ("title" NOT LIKE '[minore]%')
WHERE "kind" = 'releases';
--> statement-breakpoint
-- Rimuove il prefisso "[minore] " dal titolo: ora la significatività è una colonna.
UPDATE "doc_pages"
SET "title" = substring("title" FROM char_length('[minore] ') + 1)
WHERE "kind" = 'releases' AND "title" LIKE '[minore]%';
