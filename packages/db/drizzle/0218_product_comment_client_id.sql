-- Area 11, registro dei rimandi (review di R11-2): un commento doppio dopo un
-- errore di rete. La chiave del client di `POST /api/product-pages/:id/comments`:
-- con la stessa chiave lo stesso autore riceve lo STESSO commento («Retry» dopo
-- una risposta persa). Una per autore; null = un client che non la manda.
ALTER TABLE "product_comments" ADD COLUMN "client_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "product_comments_client_id_idx" ON "product_comments" ("author_id", "client_id") WHERE "client_id" IS NOT NULL;
