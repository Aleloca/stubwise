-- Area 11, F3 (46): le pagine di prodotto date alla chat dei Docs del progetto
-- per una risposta, solo gli id. Titolo e codice si rileggono alla riapertura
-- della sessione con la visibilità di adesso. Additiva: un server vecchio la
-- ignora.
ALTER TABLE "doc_chat_messages" ADD COLUMN "product_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;
