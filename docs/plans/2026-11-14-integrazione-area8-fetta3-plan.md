# Area 8, fetta 3 — Support: le conversazioni coi clienti nell'app

> Piano di stubwise-72 (14 nov 2026), su richiesta di stubwise-46. Il lato
> renderer è preso dal design (la sezione di 94) e lo rivede lui.
> Esecuzione: `feat/area8-f3` (server e worker, 72; da `feat/area8-f2`, che
> la F3 usa: il catalogo degli avvisi, i produttori, il routing per
> iscrizioni), `feat/area8-f3-renderer` (94).
> Design: `docs/plans/2026-11-13-integrazione-area8-design.md` (§ Fette F3,
> § Il modello dei dati F3, Review Focus F3, il lato renderer di 94 per la
> F3; la **premessa corretta** del 14 nov 2026 vale su tutto ciò che lì
> parla della risposta nel widget). Inventario:
> `docs/plans/2026-11-13-integrazione-area8-inventario.md`. Specifica: il
> prototipo (`apps/desktop/src/renderer/data/support/`,
> `domain/support/state.ts`, `domain/releases/customerStatus.ts`,
> `pages/support/`, `.impeccable/shape/support.md`) e il suo design
> (`2026-10-28-desktop-area8-releases-support-servers-design.md`), **salvo
> dove la premessa corretta lo contraddice** (sotto).

## La premessa corretta *(M, 14 nov 2026, via 46)*

La prima stesura del piano (e il prototipo) faceva rispondere il team al
cliente DENTRO il widget. **Non è così**:

- **Il team non scrive mai al cliente nel widget.** Nel widget risponde solo
  l'AI della documentazione, come oggi.
- **Una conversazione con un esito (una richiesta legata o un ticket aperto
  dal widget) è CHIUSA.** Se il cliente riscrive, si apre una conversazione
  NUOVA (un `S<n>` nuovo): il widget impara il nuovo id (un campo additivo,
  un widget vecchio continua a funzionare).
- **Il cliente segue le sue richieste e i suoi ticket sul sito che ospita
  il widget**, in una sezione che legge i dati da Stubwise via API: una
  fetta a sé DOPO la F3 (registro, «L'API per i siti»).
- **Il canale `mcp`** (i collaboratori INTERNI via Claude Code) è
  l'eccezione: lì il team risponde («lui sì, è interno»), e le risposte gli
  arrivano con `my_requests`.

Ne discende che escono dalla F3: la risposta nel widget e la sua lettura
dal widget, il compositore sulle conversazioni del widget, la bozza
automatica di Claude e «Chiedi a Claude», l'avviso
`support.customer_replied`, «Segui», gli stati `waiting_us` e `reply_sent`,
«Scrivigli per email» (il maintainer: via), e la versione Support di
«Clienti in attesa» (che resta come blocco, ma su un'altra fonte: sotto).

## Cosa entra

- **Gli stati della conversazione**, DERIVATI a lettura: in triage,
  richiesta aperta (= chiusa), non conclusa, `answered` (l'AI del widget è
  bastata, giudizio di Claude).
- **Il giudizio «conclusa / non conclusa»** dopo 15 minuti di silenzio, da
  una sessione breve del WORKER (il CLI, Haiku). Il widget non cambia.
- **«Non conclusa» a mano** e **«Apri la richiesta»** da una non conclusa,
  con la conversazione allegata; la **provenienza** nel dettaglio della
  richiesta e «View conversation» sulle task del widget (S-9).
- **La conversazione chiusa**: un messaggio su una conversazione con esito
  apre la successiva; il widget ne impara l'id.
- **I siti ammessi** del widget (`origins`): le rotte pubbliche rifiutano
  un'origine non in elenco.
- **L'avviso** `support.request`, nel catalogo della F2.
- **I codici `<PRJ>-S<n>`** delle conversazioni, l'anteprima del cliente.
- **Il canale `mcp`**: la conversazione allegata alla richiesta e la
  risposta del team al collaboratore, col suo rilascio del plugin.
- **`client.widgets`** per l'app (fatto: elenco, crea, modifica,
  elimina, `canManage`).

## Decisioni *(M, 14 nov 2026, via 46)*

- **F3-1 = a**: lo stato guarda l'ESITO — una richiesta legata o un ticket
  aperto dal widget. Il triage rifatto nel widget va nel registro; la scala
  degli stati per il cliente diventa l'API per i siti (registro).
- **F3-2 + G-1**: il giudizio lo dà SOLO una sessione del CLI dal runner
  del worker (`TrackingAgentRunner` attorno a
  `StreamingClaudeRunner`/`ClaudeCliRunner`), Haiku di default,
  `support_triage_check`, nessun tool, dopo il silenzio. L'AI del widget
  resta com'è. Account e modello da `providers/select.ts` (classe di
  sfondo) e `ai_model_settings`.
- **L'attesa: 15 minuti** (`SUPPORT_TRIAGE_IDLE_MINUTES`, letta anche dal
  renderer). Un errore costa poco: un messaggio dopo il giudizio riapre il
  triage e un secondo controllo al silenzio successivo.
- **«Non conclusa» a mano**: scrive `not_concluded` con la PERSONA come
  autrice; idempotente; nessun nuovo controllo finché il cliente non
  riscrive.
- **La premessa corretta** (sopra). **F3-3 (la bozza) e F3-5 («il cliente ha
  risposto») decadono.**
- **F3-4 = a**: il canale `mcp` nella F3, col suo rilascio.
- **Il permesso**: `support.reply` diventa **`support.manage`** (non è in
  `main`: si rinomina nella 0179). Copre «Apri la richiesta», «Non
  conclusa» e la risposta ai collaboratori del canale `mcp`. Etichetta: «Gestire
  le conversazioni di Support: aprire la richiesta, segnarle non concluse,
  rispondere ai collaboratori». «Apri la richiesta» vuole ANCHE
  `backlog.create` (nessuna strada per creare voci di backlog senza quel
  permesso).
- **I siti ammessi, elenco vuoto = tutto ammesso** *(M, 14 nov 2026)*: i widget già installati non hanno un elenco, e rifiutarli
  li spegnerebbe tutti al deploy. La UI avvisa «Qualunque sito può
  caricare questo widget». Un elenco NON vuoto rifiuta ogni origine
  assente o diversa (sotto, S16).
- **F3-6, golden**: 7 corse, `support-triage-check` ×4 e
  `chat-propose-not-execute` ×3 (`support-draft` e `support-draft-hostile`
  cancellati).

## Fuori dalla F3

- **L'API per i siti** (il cliente segue le sue richieste e i suoi ticket
  sul sito dell'host): fetta a sé dopo la F3, note nel registro.
- **«Clienti in attesa»**: resta come blocco della Home, legato alle EMAIL
  delle caselle (non al widget né alle automazioni): fetta a sé dopo la F3,
  con la cattura della posta inviata. Definizione e decisioni nel registro.
- Il triage rifatto nel widget (decisione 5 del maintainer nel design del
  prototipo): registro.
- Qualunque messaggio del team al cliente: nel widget, per email, in
  automatico. Il team parla al cliente solo attraverso lo stato delle sue
  richieste (l'API per i siti).
- Chiudere, assegnare, etichettare, unire conversazioni ([A 7]).
- La ricerca ⌘K delle conversazioni (`searchSupport`).

## Cosa c'è oggi (server)

- `widgets`, `widget_conversations` (cliente dichiarato: `external_user_id`,
  `external_user_email`, `external_user_name`; `last_message_at`),
  `widget_messages` (`role` testo libero `user`/`assistant`, `ticket_id` sul
  messaggio che ha aperto un ticket).
- L'API pubblica del widget (`apps/server/src/routes/widget.ts`): chiave
  `X-Stubwise-Key` per slug, CORS aperto (`origin: "*"`); conversazioni,
  messaggi con la risposta AI in SSE (l'evento `done` porta già
  `conversationId`), `…/tickets` → un TICKET `source: "widget"`.
- La lettura per i membri (`widget-admin.ts`), schemi inline.
- `waitingCustomers` è un tipo di blocco della Home senza dati.

## Il modello dei dati (migrazione 0179, non in `main`: si modifica)

- `projects.next_support_number` e `widget_conversations.number` (trigger,
  backfill per `created_at`): il codice `<PRJ>-S<n>`.
- `widget_conversations.channel` (`widget` | `mcp`) e `intake_job_id` (il
  canale `mcp` ritrova la conversazione dal job d'intake).
- `widget_conversations.continued_in_id` (FK su sé stessa, `set null`): la
  conversazione che ha preso il posto di questa dopo la chiusura (S17).
- Il giudizio sul triage: `triage_outcome`, `triage_outcome_at`,
  `triage_outcome_by_user_id`, `triage_checked_at`.
- `widget_messages.author_id` e `client_id` (unico per conversazione): SOLO
  per le risposte del team sul canale `mcp`; `role` `team` solo lì.
- `backlog_items.support_conversation_id`.
- `widgets.allowed_origins text[] NOT NULL DEFAULT '{}'` (S16).
- `agent_runs.operation` / `ai_model_settings.operation`:
  `support_triage_check` (solo questa; `support_reply_draft` esce).
- `notification_kind`: `support.request` (solo questo).
- Il permesso `support.manage` ai preset Project Lead, Developer, Legacy
  Member, con la regola dei preset (0135).
- **Escono** rispetto alla prima stesura: `claude_draft`, `claude_draft_at`,
  `claude_draft_through`, `draft_due_at` e il loro indice;
  `support_followers`; `support.customer_replied`; `support_reply_draft`.

## Gli stati (derivati, una funzione pura in shared)

`supportState({ hasOutcome, judgment: { outcome, at } | null, messages })`
in `@stubwise/shared` (`support/state.ts`), usata da server e renderer:
- con un esito → `request_open` (la conversazione è chiusa: i messaggi dopo
  l'esito non ci sono, vanno nella successiva);
- senza esito, il giudizio vale se è più recente dell'ultimo messaggio del
  cliente: `not_concluded` → `not_concluded`; `concluded` → `answered`;
- altrimenti `triage`.
Escono `waiting_us`, `reply_sent` e `waitingSince`. Il canale `mcp` usa gli
stessi stati (la sua conversazione nasce con la richiesta: `request_open`).
I valori tolti non sono mai stati in `main`: nessun client li conosce.

## Task del SERVER (interfacce e test; l'implementazione è di 72)

Fatti e da RITOCCARE (sono già su `feat/area8-f3`):

S1. **La migrazione 0179** e il permesso: come sopra. *Test*: il backfill dei
   codici, `support.manage` ai preset e ai ruoli che contenevano un preset;
   le colonne e i kind tolti non esistono (la 0179 non li crea).

S2. **Le letture per i membri** (chi vede il progetto; nascosto =
   inesistente): l'elenco per stato, `by-code`, `preview` (ciò che vede il
   cliente: i messaggi `customer`/`us`, lo stato in parole della richiesta o
   della task, `customerStatus` in shared). La vista perde `claudeDraft*`,
   `following`, `canReply`, `replyClosed`, `emailBlocked`, `waitingSince`;
   guadagna `continuedIn: { code } | null` e `continuedFrom: { code } | null`
   (additivi), e `canReplyToCollaborator` (solo `mcp`, `support.manage`).
   *Test* di oggi, aggiornati.

S3. **La risposta al collaboratore** (solo canale `mcp`): `POST
   …/by-code/:code/replies { body, clientId? }` (`support.manage`, rotta e
   servizio) → un messaggio `team` con l'autore. Su una conversazione
   `widget` → **409 `support_widget_no_reply`** e nessun messaggio. Nessun
   avviso, nessun follow. *Test*: 409 sul widget (e nessuna riga scritta),
   403 senza permesso, idempotenza su `clientId`, il test sul sorgente
   (nessun altro scrittore di `role: "team"`).

S6. **La richiesta da una conversazione** non conclusa (`support.manage` E
   `backlog.create`) e la provenienza derivata (`origin`,
   `supportConversationCode`): come oggi, cambia solo il permesso.

S7. **L'avviso `support.request`**: come oggi. Esce
   `publishCustomerRepliedAlert` e la sua chiamata nel widget.

S10. **Il giudizio dopo il silenzio** (worker): come oggi. *Test in più*:
   una conversazione successiva (S17) è giudicata sui SOLI suoi messaggi.

S12. **Il canale `mcp`**: come oggi (la conversazione allegata,
   `teamReplies` in `my_requests`); il changeset dice che il team risponde
   ai collaboratori interni.

S15. **«Non conclusa» a mano**: come oggi, col permesso nuovo.

Da TOGLIERE: S4 (il widget legge le risposte: `after` sul GET dei messaggi,
il polling e il messaggio `team` nel widget), S5 («Segui»), S8 (la versione
Support di `/me/waiting-customers`), S9 (la bozza email), S11 (la bozza
automatica: mai scritta), la risposta nel widget di S3.

NUOVI:

S16. **I siti ammessi.** `widgets.allowed_origins` (S1);
   `widgetAdminSchema.origins: string[]` (default `[]`) e il body di
   crea/modifica (facoltativo: un client che non lo manda lascia l'elenco
   com'è nella modifica, `[]` nella creazione). Ogni voce è un'origine
   normalizzata (`https://host[:porta]`, niente percorso; `http` solo per
   `localhost`), al massimo 20. Le rotte PUBBLICHE `/widget/:slug/*`
   (config, conversazioni, messaggi, ticket), dopo la chiave: elenco vuoto →
   tutto come oggi; elenco non vuoto → un `Origin` assente o fuori elenco
   risponde **403 `origin_not_allowed`**, prima di ogni scrittura e di ogni
   chiamata al modello. L'origine dell'istanza (`PUBLIC_URL`) è sempre
   ammessa (l'anteprima del widget nell'app). Il CORS resta `*`: il
   controllo è della rotta. Nota nella UI: l'Origin protegge dall'embed su
   siti altrui, non da un client che lo falsifica (la chiave resta
   l'autenticazione). *Test*: elenco vuoto passa senza `Origin`; elenco
   pieno rifiuta `Origin` assente, diverso, con percorso o con porta
   diversa; nessun messaggio scritto né modello chiamato al rifiuto; la
   normalizzazione (`https://A.com/` → `https://a.com`); un client che non
   manda `origins` non lo azzera; parse di una risposta senza il campo.

S17. **La conversazione chiusa** (`POST /widget/:slug/conversations/:id/messages`):
   la proprietà si controlla come oggi; se la conversazione ha un esito, il
   messaggio va alla sua **successiva**: si segue `continued_in_id` fino
   alla prima senza esito; se non c'è, se ne crea una (stesso widget,
   stesso cliente: id, email, nome; numero dal trigger) e la si lega con
   `continued_in_id`, sotto un lock della riga chiusa (due messaggi insieme
   → una successiva sola). La storia dell'AI parte dalla nuova (i messaggi
   della chiusa non entrano nel prompt). Lo stream risponde come oggi: il
   `done` porta il `conversationId` della successiva, e un evento nuovo
   `conversation` all'inizio (`{ type: "conversation", conversationId }`,
   ignorato dai widget vecchi: `toEvent` scarta i tipi sconosciuti). Il
   widget nuovo salva l'id (storage) e da lì scrive alla successiva; uno
   vecchio continua a scrivere alla chiusa, e il server lo porta comunque
   alla stessa successiva. `GET …/messages` della chiusa resta la sua storia
   (un widget vecchio la ricarica all'apertura: limite accettato, registro).
   Il ticket dal widget (`…/tickets`) su una conversazione chiusa: si apre
   sulla successiva allo stesso modo.
   *Test*: messaggio su una chiusa → una conversazione nuova con `S<n+1>`,
   il messaggio lì, `continued_in_id` sulla chiusa, nessuna riga aggiunta
   alla chiusa; due messaggi di fila sulla chiusa → la STESSA successiva;
   due insieme → una sola; la successiva chiusa a sua volta → una terza; un
   altro `userId` → 404 come oggi (nessuna successiva creata); l'evento
   `conversation` e il `done` col nuovo id; il widget (test del package)
   salva l'id nuovo e manda il messaggio dopo alla successiva; il giudizio
   del worker sulla successiva legge solo i suoi messaggi (S10).

S13. **Il client e le forme**: `client.support` (elenco, dettaglio,
   anteprima, richiesta, «Non conclusa», risposta al collaboratore),
   `client.widgets` con `origins`; ogni campo nuovo facoltativo, con un
   test che parsa una risposta senza.

S14. **Il deploy-log** (la voce della F3 riscritta: un solo
   `notification_kind`, una sola operazione AI, `support.manage`, il bundle
   del widget su caddy per l'evento `conversation`, i siti ammessi) e il
   **registro** (l'API per i siti, «Clienti in attesa», i limiti di S17).

## Task del RENDERER (94; dal design, li rivede lui)

R1. I flag: `support-widgets` (i widget, coi siti ammessi), `support-read`
   (le conversazioni in sola lettura, `RequestOrigin`, «View conversation»),
   `support` (stati, «Non conclusa», «Apri la richiesta», la risposta ai
   collaboratori sul canale `mcp`).
R2. `pages/support/` sul server: elenco, dettaglio (sola lettura per il
   widget; «Continua in S<n>» / «Seguito di S<n>»), `RequestBlock`,
   l'anteprima, i widget con i siti ammessi e l'avviso a elenco vuoto. Il
   compositore solo sulle conversazioni `mcp`.
R3. `RequestOrigin` e «View conversation» sulle task del widget.
R4. Gli avvisi `support.request` nelle Preferenze. «Clienti in attesa»
   aspetta la sua proposta.
R5. Lo stato `answered`; via `waiting_us`/`reply_sent` dal prototipo perché
   resti la specifica; via la bozza di Claude e «Segui».
R6. Il dal vivo senza stream: il dettaglio si rilegge ogni 15 s mentre è
   aperto, l'elenco ogni 30 s.

## Global Constraints

- Nessun messaggio del team al cliente del widget, da nessuna strada
  (rotta: 409; test sul sorgente: `role: "team"` lo scrive solo il servizio
  della risposta al collaboratore, e solo su `channel = 'mcp'`).
- Il cliente vede solo il suo: il widget legge solo i messaggi della sua
  conversazione; l'anteprima non mostra mai un nome del team, una stima,
  un commento.
- Il testo del cliente è NON fidato nel giudizio del worker (delimitato).
- Nascosto = inesistente; i permessi li calcola il server.
- Verso i client solo campi additivi con default; un `notification_kind`
  nuovo = un passo di rollback.
- Una richiesta non nasce MAI da un'email *(maintainer)*.

## Review Focus

- Nessun percorso scrive un messaggio del team su una conversazione del
  widget.
- Una conversazione chiusa non riceve mai un messaggio nuovo; la
  successiva è una sola anche con messaggi contemporanei; un id rubato non
  crea niente (la proprietà prima).
- I siti ammessi: il rifiuto arriva prima di ogni scrittura e di ogni
  chiamata al modello; elenco vuoto = comportamento di oggi.
- Il giudizio lo scrive solo il worker col CLI (una volta per silenzio),
  sui soli messaggi della conversazione, nel budget.

## Golden (Claude vero, F3-6: 7 corse)

Sul runner di produzione e col CLI pinnato, senza plugin:
- `support-triage-check` ×4: due conversazioni (una chiusa dalla risposta
  del widget, una con un bisogno aperto e il cliente sparito), due volte
  ciascuna → il JSON giusto, nessun tool.
- `chat-propose-not-execute` ×3 (controllo).
Pre-flight: `env | grep -c ANTHROPIC_API_KEY` = 0, CLI 2.1.322, dist del
worker rifatto; ci si ferma alla prima corsa rossa, senza rilanci.
