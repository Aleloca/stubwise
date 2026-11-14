# Area 8, fetta 3 — Support: le conversazioni coi clienti nell'app

> BOZZA di stubwise-72 (14 nov 2026), su richiesta di stubwise-46. Il lato
> renderer è preso dal design (la sezione di 94) e lo rivede lui.
> Esecuzione prevista: `feat/area8-f3` (server e worker, 72; da
> `feat/area8-f2`, che la F3 usa: il catalogo degli avvisi, i produttori, il
> routing per iscrizioni), `feat/area8-f3-renderer` (94).
> Design: `docs/plans/2026-11-13-integrazione-area8-design.md` (§ Fette F3,
> § Il modello dei dati F3, § Il motore nel worker «La risposta al cliente»,
> Review Focus F3, il lato renderer di 94 per la F3). Inventario e decisioni:
> `docs/plans/2026-11-13-integrazione-area8-inventario.md` (voci 2, 8, 10;
> S-5, S-7, S-9). Specifica: il prototipo
> (`apps/desktop/src/renderer/data/support/{reads,writes,visibility,simulate}.ts`,
> `domain/support/state.ts`, `domain/releases/customerStatus.ts`,
> `pages/support/`, `.impeccable/shape/support.md`, `claude-drafts.md` §3.4)
> e il design del prototipo
> (`2026-10-28-desktop-area8-releases-support-servers-design.md`, «Support e
> richieste dei clienti», decisioni 5–8 del maintainer).
> **Le domande per il maintainer sono in fondo** (F3-1 … F3-6): il piano è
> scritto sulle consigliate, e cambia dove una risposta è diversa.

## Cosa entra

- **La risposta di una persona** (`support.reply`, permesso nuovo) a una
  conversazione del widget: parte SOLO con «Send to customer» (l'Undo di 5 s
  è della UI: nessuna rotta di annullamento), arriva al cliente nel widget
  (che legge i messaggi nuovi), chi risponde segue la conversazione da sé.
- **Gli stati della conversazione**, DERIVATI a lettura ([A 2]): in triage,
  richiesta aperta, aspetta noi, risposta inviata, non conclusa; «aspetta
  noi da» (`waitingSince`).
- **«Segui»** ([A 14]): l'avviso obbligatorio `support.customer_replied` a
  chi segue.
- **La richiesta aperta da una conversazione** non conclusa
  (`backlog.create`), con la conversazione allegata; la **provenienza** nel
  dettaglio della richiesta e «View conversation» sulle task del widget (S-9).
- **La Home «Clienti in attesa»** (dal catalogo, per chi ha `support.reply`).
- **Gli avvisi** `support.request` e `support.customer_replied`, nel catalogo
  della F2 (le righe ci sono già; diventano vivi).
- **«Scrivigli anche per email»** (S-5): la bozza da aprire nella Posta dalla
  casella di chi risponde; il server non invia niente.
- **La bozza di Claude** della risposta (F3-3).
- **I codici `<PRJ>-S<n>`** delle conversazioni, l'anteprima del cliente.
- **Il canale `mcp`** (le richieste dal server MCP in modalità
  collaboratore), se F3-4 = a.

## Fuori dalla F3

- Il triage rifatto nel widget (domande una alla volta, desiderio riscritto
  e confermato, una RICHIESTA invece di un ticket: decisione 5 del
  maintainer nel design del prototipo). Il design dell'area 8 non lo mette
  in nessuna fetta: va nel registro (F3-1).
- Lo stato della richiesta mostrato al cliente nel widget (la scala
  «Received → … → Released»): il team lo vede nell'anteprima; il widget no
  (registro, F3-1).
- Chiudere, assegnare, etichettare, unire conversazioni, risposte salvate,
  allegati nelle risposte ([A 7]).
- Rispondere in automatico, o un'email automatica al cliente, anche di solo
  avviso *(maintainer)*.
- La ricerca ⌘K delle conversazioni (`searchSupport`): nessun consumatore in
  pagina (design, «Azioni di Claude e palette»).

## Cosa c'è oggi (server)

- `widgets`, `widget_conversations` (cliente dichiarato: `external_user_id`,
  `external_user_email`, `external_user_name`; `last_message_at`),
  `widget_messages` (`role` testo libero `user`/`assistant`, `ticket_id` sul
  messaggio che ha aperto un ticket).
- L'API pubblica del widget (`apps/server/src/routes/widget.ts`): chiave
  `X-Stubwise-Key` per slug; conversazioni, messaggi con la risposta AI in
  SSE, `…/tickets` → un TICKET `source: "widget"` (con l'intake del backlog
  per `feedback`/`feature` a backlog acceso). Nessuna lettura dei messaggi
  nuovi: il widget carica la storia all'apertura e vede solo lo stream delle
  sue domande; un `role` diverso da `user` lo disegna come l'AI.
- La lettura per i membri (`widget-admin.ts`):
  `GET /api/projects/:projectId/widget/conversations?ticketId=&widgetId=` e
  `…/:conversationId/messages`, schemi inline.
- `waitingCustomers` è un tipo di blocco della Home senza dati.
- Nessun `support.reply`; `projectRequestViewSchema` senza provenienza.

## Il modello dei dati (migrazione 0179)

- `widget_conversations`: `seq` (int) e `code` (`<PRJ>-S<n>`, unico per
  progetto, mai riusato: una sequenza per progetto come i rilasci, backfill
  per `created_at`), `channel` (`widget` | `mcp`, default `widget`).
- `widget_messages`: `role` può valere anche `team` (testo libero, nessuna
  migrazione d'enum), `author_id` (FK `users`, `set null`).
- `support_followers` (`conversation_id`, `user_id`, `created_at`; PK sulla
  coppia; `cascade` su entrambi).
- `backlog_items.support_conversation_id` (FK, `set null`): la richiesta nata
  da una conversazione.
- `support_reply_drafts` (`conversation_id`, `user_id`, `body`, `by_claude`,
  `updated_at`; PK sulla coppia) — solo con F3-3 = a.
- `notification_kind`: `support.request`, `support.customer_replied` (uno
  statement ciascuno, la regola delle migrazioni in una transazione).
- Il permesso `support.reply` ai preset Project Lead, Developer, Legacy
  Member (S-7), con la regola dei preset (`0169_automations.sql`, «regola
  0135»).

## Gli stati (derivati, una funzione pura in shared)

`supportState` del prototipo passa in `@stubwise/shared`
(`support/state.ts`), con la sua tabella di test, e la usano server e
renderer. «La richiesta» di una conversazione (F3-1 = a) è il suo ESITO:
una richiesta legata (`backlog_items.support_conversation_id`) o un ticket
aperto dal widget (`widget_messages.ticket_id`). Con un esito: ultimo
messaggio del cliente → `waiting_us`; nostro (`team`) → `reply_sent`;
altrimenti `request_open`. Senza: il cliente se n'è andato (F3-2 = a: nessun
messaggio da 30 minuti) → `not_concluded`, altrimenti `triage`. Un messaggio
nuovo del cliente su una «non conclusa» la riporta in triage da sé (lo dice
`last_message_at`). `waitingSince`: il primo messaggio del cliente in fondo,
senza risposta.

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La migrazione 0179** (sopra), il permesso nel catalogo
   (`PROJECT_PERMISSIONS`, preset), `supportState`/`waitingSince` in shared.
   *Test*: il backfill dei codici (ordine, unicità per progetto), il
   permesso ai preset e ai ruoli che contenevano un preset intero; la tabella
   degli stati (la stessa del prototipo, più il ticket come esito).

S2. **Le letture per i membri** (`member` del progetto: le conversazioni le
   vede chi vede il progetto; nascosto = inesistente, R-G5):
   - `GET /api/projects/:projectId/support/conversations?state=` → la vista
     del prototipo (`SupportConversationView`): codice, canale, cliente,
     stato, `waitingSince`, ultimo messaggio, nome del widget, la richiesta
     (codice, titolo, stato), `following`, e ciò che chi guarda PUÒ fare,
     calcolato dal server (`canReply`, `replyClosed`, `canOpenRequest`,
     `emailBlocked`). Ordine per gruppo come `byGroup`. Filtrata nella WHERE.
   - `GET /api/support/conversations/by-code/:code` → la vista con i
     messaggi (`from`: `customer` | `triage` | `team`; per un `team` l'autore
     solo a chi vede il progetto).
   - `GET /api/support/conversations/by-code/:code/preview` → ciò che vede il
     cliente: messaggi `customer`/`us`, MAI un nome del team, una bozza, una
     stima, un commento; lo stato in parole (`customerStatus`, spostato in
     shared con i suoi test).
   Le rotte di oggi (`…/widget/conversations`) restano per il web.
   *Test*: un progetto invisibile risponde come inesistente (elenco vuoto,
   404); l'anteprima non contiene il nome di chi ha risposto né la bozza;
   `canReply` falso per un Contributor; la WHERE prima del `limit`.

S3. **La risposta**: `POST /api/support/conversations/by-code/:code/replies
   { body }` (`support.reply` nel progetto, nella rotta E nel servizio).
   Scrive un messaggio `team` con l'autore, aggiorna `last_message_at`, mette
   chi risponde fra chi segue, toglie la sua bozza (F3-3). 409
   `support_triage` mentre la conversazione è in triage (R-K15: le domande le
   fa l'AI del widget). Nessun avviso, nessuna email, nessuna risposta
   automatica. Idempotente su un `clientId` facoltativo (un doppio clic o un
   «Retry» dopo un timeout non manda due messaggi).
   *Test*: senza `support.reply` 403 e nessun messaggio (Contributor, e un
   ruolo personalizzato senza il permesso); in triage 409; il messaggio non
   parte da nessun'altra strada (test sul sorgente: nessun altro scrittore di
   `role: "team"`); mutazioni sul controllo del permesso.

S4. **Il widget legge le risposte**: `GET /widget/:slug/conversations/:id/messages?after=<id>`
   (stessa chiave, stessa proprietà della conversazione di oggi: progetto,
   widget, `userId`) → solo i messaggi DOPO quello dato, della SUA
   conversazione. In `packages/widget`: un polling leggero mentre il
   pannello è aperto (ogni 15 s, e alla visibilità), e un messaggio `team`
   disegnato come il team (il nome del widget, mai la persona).
   *Test*: un altro `userId` o un'altra conversazione → 401 come oggi, e mai
   i messaggi di un altro; `after` sconosciuto → la storia intera; il widget
   (test del package) mostra il messaggio `team` e non ricarica a pannello
   chiuso. Deploy: `caddy` (il bundle del widget).

S5. **«Segui»**: `PUT /api/support/conversations/by-code/:code/follow { on }`
   (chi vede il progetto: seguire non è rispondere, R-K12).
   *Test*: segue e smette; un progetto invisibile 404.

S6. **La richiesta da una conversazione**: `POST …/by-code/:code/request
   { title, description }` (`backlog.create`), solo su una «non conclusa»;
   nasce con `support_conversation_id` e il cliente come richiedente esterno
   (nessun utente); un secondo clic (o due insieme, lock sulla conversazione)
   restituisce la stessa. Anche l'intake che nasce dal ticket del widget
   (`maybeEnqueueBacklogIntake`) lega la richiesta alla conversazione del
   ticket. La provenienza: `projectRequestViewSchema.origin`
   (`{ kind: "support", conversationCode, channel, customerName, messageCount } | null`,
   additivo, default `null`), derivata a lettura.
   *Test*: doppio clic → una richiesta; una conversazione in triage 409;
   senza `backlog.create` 403; la provenienza di una richiesta vecchia è
   `null` (parse senza il campo).

S7. **Gli avvisi** (catalogo della F2, `LIVE_ALERT_TYPES`):
   - `support.request`: alla nascita della richiesta da una conversazione
     (S6, e dall'intake del widget), una per richiesta, codice e link;
   - `support.customer_replied`: a un messaggio del cliente su una
     conversazione con un esito (F3-5 = a), ai SEGUACI come obbligatori
     (`follows_conversation`) e agli iscritti (default per `support.reply`),
     col testo del cliente come contenuto non fidato nella card.
   *Test*: un messaggio in triage non avvisa; chi segue lo riceve anche con
   l'iscrizione spenta (e la card lo dice, `alertMandatory`); un seguace che
   ha perso la visibilità no; parità del catalogo.

S8. **La Home «Clienti in attesa»**: `GET /api/me/waiting-customers` (le
   `waiting_us` dei progetti in cui chi guarda ha `support.reply`, dalla più
   vecchia attesa) e `resolveHome` con l'extra `waitingCustomers` solo dal
   catalogo (mai nelle Home di default, [A 17]).
   *Test*: senza `support.reply` vuoto; un progetto invisibile non c'è.

S9. **«Scrivigli anche per email»**: `GET …/by-code/:code/email-draft` →
   `{ slot: "support-<code>", to, subject, body }` per chi ha `support.reply`,
   con una casella collegata, fuori dal triage, se il cliente ha lasciato
   l'email (`emailBlocked` dice perché no). Non salva né invia: il renderer
   apre la Posta con questi campi, e l'invio è quello della Posta (area 6,
   con l'Undo di 10 s, dalla casella di chi scrive). Il corpo è la bozza di
   Claude se c'è (F3-3), altrimenti un testo di template (come `draftText`,
   mai il modello).
   *Test*: niente bozza durante il triage, senza email, senza casella; il
   corpo non contiene nomi del team né stime.

S10. **La bozza di Claude** (F3-3 = a): l'azione `fillSupportReply
   { conversationId, text }` nel catalogo, classe A con «Annulla»: scrive la
   bozza di CHI CHIEDE (`support_reply_drafts`, `by_claude: true`), mai al
   cliente; il renderer la mette nel campo col segno («Claude's draft», §3.4
   di `claude-drafts.md`). Una lettura per Claude,
   `read_support_conversation` (chat MCP, allowlist del token del turno),
   con la nota di contenuto NON fidato sul testo del cliente (come
   `read_release`). `GET/PUT/DELETE …/by-code/:code/draft` per il campo della
   persona (salvato dal compositore). Nessuna bozza preparata da sola a ogni
   messaggio (il prototipo la «prepara»: sul server sarebbe AI senza un
   umano davanti; F3-3).
   *Test*: senza `support.reply` la lettura e l'azione rifiutano come
   inesistente; la bozza di uno non la vede un altro; l'azione non scrive
   nessun messaggio; «Annulla» rimette la bozza di prima. Golden (F3-6).

S11. **Il canale `mcp`** (F3-4 = a): `create_backlog_item` riceve la
   conversazione (campo nuovo, facoltativo: cambio additivo,
   `@stubwise/mcp` e il plugin col changeset); il server la salva come
   conversazione `channel: "mcp"` legata alla richiesta, col cliente =
   l'utente del token. La risposta del team gli arriva con `my_requests`
   (le risposte dopo la sua ultima lettura). Le istruzioni del server MCP
   dicono che la conversazione viene allegata.
   *Test*: una richiesta con conversazione → la conversazione `mcp` con la
   provenienza; senza il campo come oggi; `my_requests` mostra la risposta
   del team solo a chi l'ha aperta.

S12. **Il client e le forme** (`packages/api-client`, `@stubwise/shared`):
   `client.support` (elenco, dettaglio, anteprima, risposta, segui,
   richiesta, bozza email, bozza), `client.me.waitingCustomers`, `origin`
   sulle richieste; ogni campo nuovo facoltativo, con un test che parsa una
   risposta senza. Il catalogo delle forme lo mando a 94.

S13. **Il deploy-log**: la voce della F3 (0179, i due `notification_kind`
   nuovi nel rollback, il permesso nuovo, server prima di worker e caddy, il
   bundle del widget su caddy, il rilascio dell'MCP se F3-4 = a).

## Task del RENDERER (94; dal design, li rivede lui)

R1. I flag: `support-widgets` (i widget sulle rotte di oggi), `support-read`
   (le conversazioni in sola lettura, `RequestOrigin`, «View conversation»
   sulle task del widget), `support` (risposta, stati, segui, richiesta,
   Home, bozza di Claude, canale `mcp`).
R2. `pages/support/` sul server: elenco, dettaglio, `ReplyComposer` con
   `replyStore.ts` (l'Undo di 5 s è suo: nessuna richiesta prima dello
   scadere, nessuna dopo un «Annulla»), `RequestBlock`, l'anteprima, i
   widget con lo snippet dall'origine vera.
R3. `RequestOrigin` e «View conversation» sulle task del widget (S-9, anche
   nel prototipo perché resti la specifica).
R4. La Home «Clienti in attesa»; gli avvisi `support.*` nelle Preferenze.
R5. «Write to them by email» → la Posta coi campi di S9.
R6. La bozza di Claude nel campo (`fillSupportReply`, il segno).
*Test* (dal design): nessuna risposta senza «Send to customer»; l'Undo non
manda niente; una conversazione di un progetto invisibile come inesistente;
la bozza di Claude non parte da sola.

## Global Constraints

- Una risposta al cliente parte SOLO dal clic di chi ha `support.reply`
  (rotta e servizio); nessuna risposta automatica, nessuna email automatica,
  nemmeno di avviso.
- Il cliente vede solo il suo: il widget legge solo i messaggi della sua
  conversazione, con la sua chiave e la sua identità; l'anteprima e il widget
  non mostrano mai un nome del team, una bozza, una stima, un commento.
- Il testo del cliente è NON fidato: nella card dell'avviso, nella lettura di
  Claude (delimitato, con la nota), nella bozza.
- Nascosto = inesistente; i permessi li calcola il server.
- Verso i client solo campi additivi con default; due `notification_kind`
  nuovi = un passo di rollback.
- Una richiesta non nasce MAI da un'email *(maintainer)*.

## Review Focus

- Una risposta parte solo con «Send to customer», e solo con
  `support.reply`; nessun percorso la scrive da solo (test sul sorgente).
- Il widget riceve solo i messaggi della sua conversazione (chiave,
  progetto, widget, `userId`), anche con un `after` inventato.
- L'email parte solo dalla Posta, dalla casella di chi scrive, coi suoi
  scope; il server non invia niente in F3.
- Il testo del cliente non diventa istruzioni nella bozza di Claude (golden
  ostile, F3-6).
- Lo stato si deriva: nessun job lo scrive; «non conclusa» non diventa
  richiesta da sola.
- I seguaci ricevono `support.customer_replied` da obbligatori, solo finché
  vedono il progetto.

## Domande per il maintainer (via 46)

F3-1. **Cos'è «la richiesta» di una conversazione, finché il widget apre
   ticket.** Oggi il widget apre un TICKET (`source: "widget"`), non una
   richiesta; il triage del prototipo (domande una alla volta, desiderio
   confermato, una richiesta) non è in nessuna fetta dell'area 8.
   (a) Lo stato guarda l'ESITO: una richiesta legata o un ticket aperto
   dal widget; il triage rifatto nel widget e la scala degli stati per il
   cliente vanno nel registro. *(consigliata: la F3 si usa subito con il
   widget di oggi)* (b) La F3 rifà anche il triage del widget (una
   richiesta, mai un ticket): una fetta in più, col golden del triage.

F3-2. **Quando una conversazione è «non conclusa».** Il server non sa quando
   il cliente se ne va. (a) Derivato: nessun esito e nessun messaggio da 30
   minuti. *(consigliata: nessun evento in più dal widget, e un messaggio
   nuovo la riporta in triage da sé)* (b) Un evento del widget alla
   chiusura del pannello (inaffidabile: una scheda chiusa non lo manda).

F3-3. **La bozza di Claude della risposta.** (a) Su richiesta: Claude nel
   riquadro legge la conversazione e mette la bozza nel campo di chi chiede
   (`fillSupportReply`, A con «Annulla», salvata per persona); nessuna
   bozza preparata da sola. *(consigliata: nessuna spesa di AI senza un
   umano davanti, come la Posta)* (b) Come il prototipo: una bozza
   preparata dal worker a ogni messaggio del cliente su una conversazione
   che aspetta noi, nel budget mensile (come S-10). (c) Solo un testo di
   template, senza modello.

F3-4. **Il canale `mcp` in questa fetta.** Tocca `@stubwise/mcp` e il
   plugin (un rilascio npm col changeset). (a) Dentro la F3, come ultimo
   task e rilascio a parte. *(consigliata: il design lo mette nella F3)*
   (b) Nel registro, dopo la F3.

F3-5. **Quando avvisare «il cliente ha risposto».** Il prototipo avvisa a
   ogni messaggio del cliente. (a) Solo su una conversazione con un esito
   (aspetta noi): durante il triage risponde l'AI del widget, e un avviso a
   ogni domanda sarebbe rumore. *(consigliata)* (b) A ogni messaggio, come il
   prototipo.

F3-6. **Il golden (Claude vero) della bozza** (se F3-3 = a o b): gli scenari
   nuovi `chat-support-draft` (UNA `fillSupportReply` sulla conversazione
   giusta, nessun nome del team né stima) e `chat-support-hostile` (un
   messaggio del cliente con istruzioni ostili: nessuna azione oltre alla
   bozza, l'istruzione riportata come contenuto). (a) 3 + 5 corse, più
   `chat-propose-not-execute` ×3 di controllo *(consigliata)* (b) la serie
   intera della chat; (c) nel registro, al prossimo aggiornamento del CLI.
