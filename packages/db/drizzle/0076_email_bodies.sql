-- La posta si legge per conversazione, parte A (design §1, Task 1): la CACHE
-- del corpo originale di un messaggio.
--
-- Additiva, nessun ALTER TYPE, un solo batch, NESSUN backfill: la cache nasce
-- vuota e si riempie alla prima lettura di ogni messaggio (`GET
-- /api/me/mail/:source/:id/original`). Scendere di immagine sul server è
-- innocuo — la rotta vecchia chiama Gmail e ignora questa tabella.
--
-- ⚠️ `body_html` è l'HTML **GREZZO**, non il sanificato, ed è una scelta
-- motivata nel design §1: `sanitizeEmailHtml` resta nel percorso di RISPOSTA
-- (`apps/server/src/routes/me-mail.ts`), dove gira a ogni lettura. Conservare
-- il sanificato congelerebbe ogni riga alla versione del filtro che l'ha
-- scritta, e correggere il filtro richiederebbe una colonna di versione più
-- un ri-scaricamento da Google; conservando il grezzo, una correzione a
-- `sanitizeEmailHtml` vale retroattivamente su tutto ciò che è già in cache.
-- L'HTML in una colonna è dato, non viene eseguito: il rischio non è lo
-- storage, è cosa esce verso il client — e quello esce sanificato sempre.
--
-- ⚠️ Perché una TABELLA A SÉ e non una colonna accanto a
-- `email_messages.text_excerpt`: l'estratto è ciò che la CLASSIFICAZIONE ha
-- letto davvero (ed è su quello che il modello ha deciso); questa è una copia
-- per CHI LEGGE, che nessun altro codice consulta. Tenerli sulla stessa riga
-- li metterebbe sullo stesso piano — vedi l'invariante riscritta in
-- CLAUDE.md, «Il corpo HTML di un'email: dove si conserva, e dove no».
--
-- ⚠️ Nessuna SCADENZA, e non è una svista: un messaggio Gmail è immutabile,
-- una volta inviato non cambia più. L'unico modo in cui questa cache può
-- diventare falsa è che il messaggio sparisca da Gmail — e allora sparisce
-- anche la riga padre, che si porta dietro questa con il CASCADE. Per la
-- stessa ragione la potatura di `email_messages` non va toccata per lei.
CREATE TABLE "email_bodies" (
  -- PK e FK insieme: una riga di cache per messaggio, e muore col messaggio.
  "email_message_id" uuid PRIMARY KEY NOT NULL REFERENCES "email_messages"("id") ON DELETE CASCADE,
  -- Gli header COME LI HA MANDATI GMAIL, non normalizzati: la rotta oggi
  -- preferisce questi a quelli della riga padre e ci ricade sopra solo
  -- quando mancano (`full.headers.subject ?? message.subject`). NULL qui
  -- significa "l'header non c'era", ed è ciò che fa scattare lo stesso
  -- fallback di sempre — non un valore vuoto da interpretare.
  "subject" text,
  "from_address" text,
  "to_addresses" text[],
  "cc_addresses" text[] NOT NULL DEFAULT '{}',
  -- Il corpo `text/plain` se il messaggio ce l'aveva. NULL quando c'era solo
  -- HTML: la conversione in testo la fa la rotta, non si conserva un
  -- derivato che il codice sa ricalcolare.
  "body_text" text,
  -- HTML GREZZO (vedi sopra). NULL quando il messaggio non aveva una parte
  -- HTML — mai una stringa vuota, che un client dovrebbe interpretare a sé.
  "body_html" text,
  -- `[{ filename, mimeType }]`, la stessa forma che `mailOriginalSchema`
  -- espone: sono metadati, il contenuto degli allegati non si scarica né si
  -- conserva.
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Quando è stato letto da Gmail: la risposta lo espone, così la copy può
  -- dire la verità su da dove arriva il corpo (design §1, Task 3).
  "fetched_at" timestamptz NOT NULL DEFAULT now()
);
