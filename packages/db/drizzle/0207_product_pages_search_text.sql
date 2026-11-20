-- Area 11, F3: il testo cercabile di una pagina di prodotto, già piegato
-- (senza maiuscole né accenti) da `productSearchText` in TypeScript: il
-- database non piega allo stesso modo in ogni codifica. Lo scrivono le tre
-- scritture di titolo e corpo; le pagine di prima lo ricevono dal poller degli
-- embedding (hanno tutte `embedded_at` null).
ALTER TABLE "product_pages" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;
