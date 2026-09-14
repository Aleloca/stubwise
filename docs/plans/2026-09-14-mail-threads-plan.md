# Piano — La posta si legge per conversazione

Design: `docs/plans/2026-09-14-mail-threads-design.md` (approvato a sezioni
dal maintainer il 14 set 2026).

Il piano è in **due parti indipendenti**. La parte A (cache) è completa e
deployabile da sola: non dipende da nulla della parte B. Chi esegue può
fermarsi lì e far verificare, poi proseguire.

---

## Parte A — La cache del corpo originale

### Task 1 — Migrazione 0076: `email_bodies`

Tabella nuova, una riga per messaggio:

- `email_message_id uuid` PK, FK → `email_messages.id` **ON DELETE CASCADE**
- le colonne che servono a ricostruire `mailOriginalSchema` senza chiamare
  Gmail: corpo testo, corpo HTML **GREZZO** (vedi design §1), cc, allegati
  (jsonb), più gli header che la rotta oggi preferisce prendere dal vivo
  (subject/from/to)
- `fetched_at timestamptz not null`

Additiva, nessun `ALTER TYPE`, un solo batch, nessun backfill: la cache nasce
vuota e si riempie alla prima lettura di ogni messaggio.

### Task 2 — La rotta legge la cache, e se non c'è la riempie

`GET /api/me/mail/:source/:id/original`
(`apps/server/src/routes/me-mail.ts`): cache presente → si risponde da lì,
**sanificando l'HTML adesso** (`sanitizeEmailHtml` resta esattamente dov'è, nel
percorso di risposta — è il punto del design §1); assente → si chiama Gmail
come oggi, si scrive la riga, si risponde.

Un fallimento della SCRITTURA in cache non deve far fallire la risposta: il
corpo ce l'abbiamo in mano, la cache è un'ottimizzazione. Una riga di log,
non un 502.

I tre errori di oggi (`message_gone`, `token_expired`, `google_unavailable`)
restano quelli, e valgono solo per il percorso che chiama Gmail davvero.

**Test**: la seconda lettura non chiama Gmail (spia sul client a zero); una
cache scritta con HTML ostile esce sanificata; il messaggio cancellato
cancella la riga di cache (cascade); una scrittura in cache che fallisce
restituisce comunque il corpo.

### Task 3 — La risposta dice DA DOVE viene il corpo

Campo nuovo su `mailOriginalSchema` (`packages/shared`): da dove arriva il
corpo e quando è stato letto da Gmail. **`.optional()`/`.default()`**, mai
obbligatorio, con il test che parsa una risposta senza — regola di CLAUDE.md,
«verso l'app mobile solo cambi additivi».

Serve perché oggi la copy accanto al bottone promette che il messaggio verrà
chiesto a Google *adesso*: servita dalla cache sarebbe falsa.

### Task 4 — La copy, su entrambe le superfici

`apps/web` (`mail-reading-pane.tsx`) e `apps/mobile`
(`MailDetailScreen.tsx`) + le chiavi i18n: la frase dice la verità nei due
casi. Nessuna promessa di una chiamata che non avviene.

### Task 5 — L'invariante di CLAUDE.md

Riscrivere «Il corpo HTML di un'email non si conserva mai (fase 9)» —
**riscrivere, non cancellare**: la ragione che c'era dentro (un corpo
persistito è un'affermazione implicita su ciò che Stubwise ha letto) è ancora
quella che tiene la cache in una tabella a sé e non in una colonna accanto a
`text_excerpt`. Va detto che ora si conserva, dove, perché grezzo, e che la
distinzione fra «ciò che la classificazione ha letto» e «una copia per chi
legge» resta.

---

## Parte B — Il thread

### Task 6 — `threads.get` in `@stubwise/google`

Una funzione accanto a `getMessageFull` (`packages/google/src/gmail.ts`),
stesso stile: `format=full`, `parseGoogleJson` con uno schema proprio, la
stessa normalizzazione `toMessage` per ogni messaggio del thread.

**Test**: un thread con tre messaggi normalizza tutti e tre; un thread
inesistente dà `GoogleApiError` 404 come le sorelle.

### Task 7 — Migrazione 0077: `email_messages.admitted`

`boolean not null default true`. Il default è anche il backfill corretto: ogni
riga esistente è passata dal cancello. Additiva, un solo batch.

### Task 8 — Il poller tira dentro il thread

`syncGmail` (`apps/worker/src/google/poller.ts`), subito dopo che
`admit(...)` è passato: si chiede il thread intero, si inseriscono i fratelli
mancanti con `admitted: false`, corpi capati come oggi, sempre con
`onConflictDoNothing` (l'unique `(account_id, gmail_message_id)` resta
l'idempotenza del poller).

Un fratello già presente **non si tocca**: se era ammesso resta ammesso.

⚠️ Un fallimento del `threads.get` non deve far perdere il messaggio
ammesso né il cursore: si inserisce comunque il messaggio, si logga, il
contesto arriverà al giro dopo.

**Test**: un thread da tre con uno solo ammesso inserisce tre righe, una
`admitted: true` e due `false`; rieseguire il tick non duplica; un
`threads.get` che fallisce lascia comunque entrare l'ammesso.

### Task 9 — La potatura si lega al thread

`pruneOldEmails` (stesso file): un messaggio con `admitted = false` è potabile
solo quando lo è **ogni messaggio ammesso del suo thread**. Senza questo, il
contesto sarebbe il primo a sparire (non ha figli `email_proposals`, quindi
oggi soddisfa la condizione banalmente) e resterebbe una conversazione coi
buchi — vedi design §2.

**Test**: un thread con una proposta ancora aperta non perde i suoi messaggi
di contesto; un thread tutto terminale e vecchio se ne va intero.

### Task 10 — Solo l'ultimo messaggio propone, e legge il thread

`classifyNewMessages`/`loadContext` (`apps/worker/src/google/classify.ts`):

- un messaggio con `admitted = false` non viene mai classificato;
- di un thread si classifica **l'ultimo** messaggio ammesso, non ognuno;
- il contesto passato al modello comprende i messaggi che lo precedono,
  **cappati agli ultimi N**: il costo di un run non deve crescere con la
  lunghezza della conversazione.

Le tre difese di costo della fase 6c (`GMAIL_MAX_PER_DAY`, gate di budget,
cooldown per thread) restano tutte dove sono.

**Test**: tre messaggi ammessi nello stesso thread producono UNA
classificazione, non tre; un messaggio di contesto non ne produce nessuna; il
cap sul contesto regge su un thread lungo.

### Task 11 — Che rapporto ha la risposta con la proposta aperta

Quando il thread ha già una proposta aperta, la classificazione la riceve e
dice se il messaggio nuovo **integra**, **sostituisce** o è una **richiesta
nuova** (design §3). I primi due casi finiscono nello stesso posto: una sola
card, riscritta. Il terzo fa nascere una seconda card, e la prima resta.

La **rivalidazione della fase 6 non si scavalca**: ticket, progetto e data che
il modello nomina passano dallo stesso controllo di sempre.

**Test**: integra → una card sola, contenuto aggiornato; sostituisce → una
card sola; richiesta nuova → due card aperte sullo stesso thread; un
referente che non regge fa sparire l'azione come prima.

### Task 12 — Una card superata non sparisce in silenzio

La proposta chiusa perché superata porta un esito esplicito che dice **da
cosa**, resta leggibile fra le gestite, e la card nuova dichiara di venire da
lì (design §3).

**Test**: dopo una sostituzione la vecchia è chiusa con quell'esito e
ritrovabile; la nuova porta il riferimento.

### Task 13 — Le rotte per thread, ACCANTO a quelle esistenti

Nel server: la lista per conversazione (oggetto, ultimo mittente, data
dell'ultimo messaggio, quanti messaggi) e il dettaglio di un thread (i
messaggi in ordine, ciascuno col suo corpo e la sua provenienza —
ammesso o contesto).

⚠️ `GET /api/me/mail` **non cambia forma**: la legge un'app già installata
(CLAUDE.md, «solo cambi additivi»), e la usa anche il calendario, che thread
non ne ha. Le rotte nuove nascono accanto.

ACL invariata: `user_id` sempre nel WHERE, nessun ruolo scavalca.

**Test**: un utente non vede i thread di un altro, admin compreso; un thread
con messaggi di contesto li mostra nel dettaglio ma non come righe della
lista; la paginazione regge su thread con date miste.

### Task 14 — Il web: `/mail` per conversazione

`apps/web`, pagina a tre colonne (`mail-workspace.tsx`,
`mail-reading-pane.tsx`): la colonna centrale elenca thread, il pannello di
lettura mostra i messaggi in ordine. L'HTML dell'originale resta
nell'`<iframe sandbox>` senza `allow-scripts` né `allow-same-origin`, con le
immagini remote neutralizzate finché non si chiede di mostrarle — invariante
della fase 9, non si tocca.

### Task 15 — L'app: MBX per conversazione

`apps/mobile`: la lista MBX/MAIL elenca thread; il dettaglio mostra i
messaggi in ordine. Il corpo resta TESTO, mai markdown (asterischi e trattini
letterali), coi link toccabili solo `http`/`https` — `LinkedText`/`linkify`,
già fatti il 13 set 2026.

Il filtro `source=email` introdotto il 14 set 2026 resta: il calendario ha la
sua scheda.

### Task 16 — CLAUDE.md e guida utente

- L'ammissione della fase 6c si allarga: il thread di un messaggio ammesso
  entra intero. Va scritto come decisione, col limite che la rende
  accettabile — `admitted = false` non diventa mai una card, in nessun
  percorso.
- L'invariante nuova: **una proposta per richiesta, non per messaggio**.
- La potatura legata al thread.
- La guida utente (`apps/docs`) dove parla di posta e proposte.

---

## Deploy

Rebuild **server + worker + caddy insieme** (migrazioni 0076 e 0077 all'avvio
del server; il worker nuovo è l'unico che tira dentro i thread e classifica
per conversazione, il server nuovo l'unico che espone le rotte per thread, il
bundle nuovo l'unico che le disegna). L'app si distribuisce a parte.

Entrambe le migrazioni sono additive, senza `ALTER TYPE` e senza backfill:
scendere di immagine sul server non richiede di ripulire righe prima (nessun
`notification_kind` nuovo, nessun valore aggiunto a un enum esistente).
