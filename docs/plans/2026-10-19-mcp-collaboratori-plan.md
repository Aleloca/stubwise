# MCP di Stubwise per i collaboratori — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chiunque abbia un utente Stubwise può, da Claude Code, chiedere come funziona un progetto, segnalare un bug, aprire una richiesta e seguirne lo stato; il maintainer viene avvisato.

**Architecture:** il server impara chi ha chiesto cosa (autore sui ticket, richiedenti sulle voci di backlog, filtro «mine»), avvisa gli admin con un `notification_kind` nuovo e non cambia nulla della chat dei Docs. L'MCP aggiunge tre tool (recupero dai Docs senza generazione, lettura pagina, «le mie richieste»), le `instructions` di server col flusso per i collaboratori, la configurazione da file e un sotto-comando `setup`. Il web aggiunge la sezione «Claude Code» che genera il comando d'installazione.

**Tech Stack:** Drizzle/Postgres, Fastify + Zod, `@modelcontextprotocol/sdk` 1.29 (`ServerOptions.instructions`), React + TanStack (web), React Native (app), Vitest/Jest.

**Spec:** `docs/plans/2026-10-19-mcp-collaboratori-design.md` — leggilo prima di ogni task.

## Global Constraints

- Lingua: codice e commenti in italiano come il resto del repo; testi verso l'utente in it + en dove esistono i due cataloghi.
- **Nessuna generazione lato server per le domande sui Docs**: l'MCP restituisce passaggi, mai una risposta scritta dal server; la chat `POST …/docs/chat` non si usa.
- **Nessuna limitazione di tool per profilo**; si adattano solo le istruzioni.
- Progetto: l'agente lo intuisce ma **chiede sempre conferma** prima di usarlo.
- Prima di aprire un bug o una richiesta: **bozza mostrata e conferma esplicita**; mai dettagli inventati.
- Richiesta su progetto con `backlogEnabled = false` → ticket `type: "feature"` invece di voce di backlog.
- Autore: solo creazioni di un utente autenticato (web, MCP). Widget/Slack/posta: nessun autore. Conversione voce → ticket passa l'autore. Nessun backfill.
- Avviso al maintainer: card in inbox per gli **admin**, con push, **solo se chi crea è `member`** (un admin che apre un ticket per sé non si auto-notifica — scelta del piano). Per una richiesta di backlog la card nasce quando l'intake ha creato o fuso la voce.
- Migrazioni: un `ALTER TYPE … ADD VALUE` in una migrazione a sé, valore mai usato nello stesso batch (CLAUDE.md, «Migrazioni Drizzle»).
- Notifiche: i campi che il client legge si derivano a lettura quando possibile (CLAUDE.md, «I campi che un client legge su una card di inbox…»).
- Plugin: ogni modifica sotto `plugins/stubwise/` vuole un changeset che nomini **`@stubwise/claude-plugin` e `@stubwise/mcp`**; versioni riallineate con `pnpm version-packages` (non a mano); `.mcp.json` resta in forma `${VAR:-}`.
- Prima di ogni commit del task: `pnpm --filter <pkg> typecheck`, test del package, `pnpm exec eslint <file toccati>`. Test con testcontainers: Docker si avvia solo per i test e si ferma dopo.

## Review Focus

- Una richiesta **fusa** dall'intake in una voce esistente: chi l'ha chiesta deve ritrovarla in «le mie richieste» e l'MCP deve dirgli che è stata unita (test in Task 2 e Task 6).
- Un collaboratore senza repository: nessun messaggio deve citare `/stubwise:init` o comandi da terminale (test in Task 6 e Task 7).
- Un token o un URL mancanti/sbagliati nel file di configurazione: errore comprensibile, le variabili d'ambiente vincono sul file (test in Task 5).
- Una pagina dei Docs enorme letta da `read_doc_page`: troncata con avviso, non un muro di testo (test in Task 6).
- Un admin che crea ticket ogni giorno dal web: nessuna card a se stesso (test in Task 3).

---

### Task 1: Autore su ticket e richiedenti delle voci (DB + shared)

**Files:**
- Modify: `packages/db/src/schema.ts` (`tickets` ~581, dopo `backlogItems` ~2572)
- Create: `packages/db/drizzle/0092_requesters.sql`, voce idx 92 in `packages/db/drizzle/meta/_journal.json` (`when` = 1792368000000)
- Create: `packages/db/src/migration-0092.test.ts`
- Modify: `packages/shared/src/schemas/backlog.ts` (payload manuale dell'intake, ~49-56; `createBacklogItemSchema` resta invariato)
- Modify: `packages/shared/src/schemas/ticket.ts` (vista pubblica del ticket) e lo schema della voce di backlog (vista base)

**Interfaces:**
- Produces:
  - colonna `tickets.requested_by_user_id uuid null references users(id) on delete set null` → Drizzle `requestedByUserId`.
  - tabella `backlog_item_requesters (item_id uuid not null references backlog_items(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, requested_at timestamptz not null default now(), primary key (item_id, user_id))` → Drizzle `backlogItemRequesters`, indice su `user_id`.
  - payload manuale dell'intake: `{ title, body, requestedByUserId?: uuid }.strict()` (opzionale: i job già in coda restano validi).
  - campo di risposta `requestedBy: { id: string; email: string } | null` sulla vista pubblica del ticket e sulla voce di backlog — `.nullable().optional()` (regola dei cambi additivi verso i client).

- [ ] **Step 1: test della migrazione** `migration-0092.test.ts` (pattern di `migration-0091.test.ts`, `migrationsFolderUpTo(91)` poi la 0092 vera): un ticket esistente ha `requested_by_user_id` NULL; inserire due richiedenti sulla stessa voce funziona, lo stesso utente due volte viola la PK; cancellare l'utente azzera `tickets.requested_by_user_id` e toglie le righe di `backlog_item_requesters`; cancellare la voce toglie le sue righe.
- [ ] **Step 2: eseguirlo** — `pnpm --filter @stubwise/db test -- migration-0092` → FAIL (file di migrazione assente).
- [ ] **Step 3: scrivere la 0092 e lo schema Drizzle**; aggiornare `backlogIntakePayloadSchema` (ramo manuale con `requestedByUserId` opzionale) e un test in `packages/shared/src/schemas/backlog.test.ts`: payload con `requestedByUserId` valido passa, con un campo ignoto fallisce ancora (`.strict()`).
- [ ] **Step 4:** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/db... build && pnpm --filter @stubwise/db test` → PASS (incluso `enum-parity`).
- [ ] **Step 5: commit** `feat(db,shared): chi ha chiesto cosa — autore dei ticket e richiedenti delle voci`.

### Task 2: Scrivere l'autore e filtrare «le mie» (server + worker)

**Files:**
- Modify: `apps/server/src/db/tickets.ts:60` (`CreateTicketInput` + insert)
- Modify: `apps/server/src/routes/tickets.ts` (POST `/` ~484, `listTicketsQuerySchema` ~103, GET `/` ~537, `toPublicTicket`)
- Modify: `apps/server/src/services/backlog-intake.ts:48`, `apps/server/src/routes/backlog.ts` (POST `/` ~593, `listQuerySchema` ~59, GET `/` ~211, vista base), `apps/server/src/services/backlog.ts:54` (`convertBacklogItem`)
- Modify: `apps/worker/src/backlog/intake.ts` (`mergeIntoItem` ~145, `createNewItem` ~191, ramo da ticket ~325)
- Test: `apps/server/src/routes/tickets.test.ts`, `apps/server/src/routes/backlog.test.ts`, `apps/server/src/services/backlog.test.ts` (o dove sta il test di `convertBacklogItem`), `apps/worker/src/backlog/intake.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `CreateTicketInput.requestedByUserId?: string | null`.
  - `EnqueueBacklogIntakeInput.requestedByUserId?: string`.
  - query `mine=true` (stringa `"true"`/assente, `z.enum(["true"]).optional()`) su `GET /api/tickets` e `GET /api/backlog`: filtra per `tickets.requested_by_user_id = request.user.id` / esistenza di una riga in `backlog_item_requesters` per l'utente. Con `mine`, `GET /api/backlog` include anche le voci `converted`/`archived` (lo stato serve proprio a seguirle).
  - helper worker `addRequester(tx, itemId: string, userId: string): Promise<void>` (`insert … on conflict do nothing`).

- [ ] **Step 1: test falliti**
  - tickets: `POST /api/tickets` come member → `requestedBy.id` = member; `GET /api/tickets?mine=true` restituisce solo i suoi; un ticket creato da ingest SDK non ha autore.
  - backlog: `POST /api/backlog` mette `requestedByUserId` nel payload del job; `GET /api/backlog?mine=true` restituisce una voce `converted` di cui l'utente è richiedente.
  - worker intake: voce nuova da payload con `requestedByUserId` → una riga in `backlog_item_requesters`; **merge** in una voce esistente → riga aggiunta alla voce di DESTINAZIONE (Review Focus); intake da ticket con `requested_by_user_id` → l'autore del ticket diventa richiedente; payload senza autore → nessuna riga.
  - `convertBacklogItem`: il ticket creato ha `requested_by_user_id` = il richiedente con `requested_at` più vecchio; voce senza richiedenti → NULL.
- [ ] **Step 2:** eseguire i test indicati → FAIL.
- [ ] **Step 3: implementare** (server: `requestedByUserId: request.user!.id` nei due POST; `requestedBy` nelle risposte con join su `users` per l'email; worker: `addRequester` nelle due transazioni dell'intake; `convertBacklogItem`: scegliere il richiedente più vecchio dentro la stessa transazione). `POST /api/backlog/from-design` aggiunge anch'essa l'utente come richiedente (stessa API, stessa regola).
- [ ] **Step 4:** `pnpm --filter @stubwise/server test` e `pnpm --filter @stubwise/worker test` → PASS; typecheck e lint.
- [ ] **Step 5: commit** `feat(server,worker): chi ha chiesto cosa — autore alla creazione, «mine» sulle liste`.

### Task 3: Avviso agli admin (`request.created`)

**Files:** tutti i punti di un `notification_kind` nuovo, sull'esempio di `docs.nightly_attention` (commit 12ebf528 + 47864504):
- `packages/db/drizzle/0093_request_created_notification.sql` (solo `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'request.created';`), journal idx 93, `packages/db/src/schema.ts:1146`, `packages/shared/src/schemas/notification.ts:30`
- `packages/notifications/src/`: `format.ts` (evento, union, emoji, link, chiave i18n, campi escapati, JSON webhook, esempio), `routing.ts` (`"request.created": "admins"`), `dispatch.ts:91` (toggle webhook: riusa una colonna esistente, nessuna colonna nuova), `actions.ts:116` (`{ decisions: [], adminOnly: true, archivable: true }`, `openUrl`), `push/payload.ts`, `index.ts`; Create: `packages/notifications/src/request-created.ts`
- `packages/i18n/src/catalog.ts` (`push.title.request.created`, `notify.request.created` in EN e IT)
- Web: `apps/web/src/components/inbox-item.tsx:37`, `notifications-section.tsx:55`, `apps/web/src/i18n/locales/{it,en}.json`
- App: `apps/mobile/src/components/inbox/InfoCard.tsx:17`, `apps/mobile/src/i18n/{it,en}.json`, `apps/mobile/src/lib/open-ticket.ts:23` (solo per la variante bug)
- Chiamanti: `apps/server/src/routes/tickets.ts` (POST `/`), `apps/worker/src/backlog/intake.ts`

**Interfaces:**
- Produces:
  - `RequestCreatedEvent { kind: "request.created"; requestKind: "bug" | "feature" | "backlog"; projectId; projectName; title; requesterEmail; ticketId?: string; ticketNumber?: number; backlogItemId?: string; merged: boolean }`.
  - `publishRequestCreated(db: DbOrTx, input: Omit<RequestCreatedEvent, "kind">, deps?: { publish?: typeof publishNotification }): Promise<void>` — mai lancia (come `publishDocsNightlyAttention`).
  - Testo IT della card: «{email} ha segnalato un bug su {progetto}: {titolo}» / «{email} ha chiesto su {progetto}: {titolo}» (+ «— unita a una richiesta simile già aperta» se `merged`).

- [ ] **Step 1: test falliti**: `request-created.test.ts` (evento → titolo/link corretti per bug e per voce, `merged` cambia il testo); routing (`admins`); `tickets.test.ts`: member crea un bug → una notifica `request.created` per gli admin; **admin crea un bug → nessuna** (Review Focus); member crea un `task` → nessuna; worker `intake.test.ts`: voce creata con richiedente member → notifica con `backlogItemId`; fusa → `merged: true`; senza richiedente → nessuna. Test di parità dell'enum, web `inbox.test.tsx` (la card mostra l'etichetta), app `InboxCard.test.tsx`.
- [ ] **Step 2:** eseguirli → FAIL.
- [ ] **Step 3: implementare**. Server: dopo il commit della transazione di `POST /api/tickets`, se `request.user.role === "member"` e il ticket non è stato deviato in intake (`maybeEnqueueBacklogIntake` ha restituito `false`) → `publishRequestCreated` con `requestKind` = tipo del ticket se `bug`/`feature`, altrimenti nessun avviso. Worker: dopo la transazione di `createNewItem`/`mergeIntoItem`, se il payload ha un richiedente con ruolo `member` → pubblica (`requestKind: "backlog"`).
- [ ] **Step 4:** test di shared, notifications, i18n, server, worker, web, mobile → PASS (ribuildare i package toccati prima dei test dei consumatori).
- [ ] **Step 5: commit** `feat: il maintainer sa quando un collaboratore apre un bug o una richiesta`.

### Task 4: Client MCP — nuovi metodi

**Files:**
- Modify: `packages/mcp/src/client.ts` (params ~268-300, classe ~377)
- Test: `packages/mcp/src/client.test.ts`

**Interfaces:**
- Produces (in `StubwiseClient`):
  - `getMe(): Promise<{ id: string; email: string; role: "admin" | "member" }>` — `GET /api/auth/me`, validato.
  - `searchProjectDocs(projectId: string, q: string): Promise<DocsPassage[]>` — `GET /api/projects/:projectId/docs/search?q=`; `DocsPassage { slug; title; snippet; score; repositoryId; repositoryName }`.
  - `getDocPage(repositoryId: string, slug: string): Promise<{ title: string; body: string; updatedAt: string }>` — `GET /api/repositories/:repositoryId/docs/pages/:slug`.
  - `listTickets` / `listBacklog` accettano `mine?: boolean` (→ `mine=true`) e `projectId` opzionale.
  - `getProject(id)` già disponibile tramite la lista: esporre `backlogEnabled?: boolean` nel tipo `Project` (lo schema è `.loose()`).
  - `getBacklogJobResult` già esiste (`getBacklogJob`); aggiungere a `BacklogItem` il campo `createdAt` se non c'è (serve a capire la fusione).
  - `listTicketComments(ticketId: string): Promise<{ body: string; author: string | null; createdAt: string; deletedAt: string | null }[]>` — `GET /api/tickets/:id/comments` (lo usa già `packages/api-client/src/endpoints/tickets.ts:149`); i commenti eliminati (`deletedAt` valorizzato, corpo vuoto) si scartano.

- [ ] **Step 1: test falliti** in `client.test.ts` (pattern `fetchMock.mock.calls[0]`): URL e query esatti per i sei metodi; `getMe` con risposta malformata → `invalid_response`.
- [ ] **Step 2:** `pnpm --filter @stubwise/mcp test -- client` → FAIL.
- [ ] **Step 3:** implementare.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: commit** `feat(mcp): client per i Docs, il profilo e le richieste dell'utente`.

### Task 5: Configurazione da file e sotto-comando `setup`

**Files:**
- Modify: `packages/mcp/src/config.ts`, `packages/mcp/src/index.ts`
- Create: `packages/mcp/src/setup.ts`
- Test: `packages/mcp/src/config.test.ts`, `packages/mcp/src/setup.test.ts`

**Interfaces:**
- Produces:
  - file personale `~/.config/stubwise/config.json` = `{ "url": string, "token": string }` (stesso percorso su macOS, Linux e Windows: `path.join(os.homedir(), ".config", "stubwise", "config.json")`; sovrascrivibile con `STUBWISE_CONFIG`).
  - `loadConfig({ cwd, env, readUserConfig? })`: ordine **env > file > default**; token assente in entrambi → errore in parole semplici che rimanda alla sezione «Claude Code» delle impostazioni di Stubwise (non alle variabili d'ambiente).
  - `runSetup(argv: string[], deps: { fetch, writeFile, mkdir, chmod, log }): Promise<number>` — `npx -y @stubwise/mcp setup --url <url> --token <token>`: verifica il token con `GET /api/auth/me` (fallisce con messaggio chiaro se 401 o URL irraggiungibile), scrive il file con permessi `0600`, stampa «Configurato come <email> su <url>». `index.ts`: se `argv[2] === "setup"` esegue `runSetup` invece del server.

- [ ] **Step 1: test falliti**: env vince sul file; solo file → usa il file; file con JSON rotto → errore che nomina il file; nessuno dei due → messaggio senza «variabile d'ambiente»; `runSetup` con token valido scrive il file `0600` e restituisce 0; 401 → restituisce 1 e non scrive nulla; URL senza schema → errore.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** implementare (dipendenze iniettate, nessun accesso reale al disco nei test).
- [ ] **Step 4:** → PASS; `pnpm --filter @stubwise/mcp build` e prova manuale `node packages/mcp/dist/index.js setup --url http://localhost:1 --token x` → messaggio d'errore leggibile, exit 1.
- [ ] **Step 5: commit** `feat(mcp): configurazione da file e npx @stubwise/mcp setup`.

### Task 6: Tool nuovi e istruzioni di server

**Files:**
- Create: `packages/mcp/src/tools/docs.ts`, `packages/mcp/src/tools/requests.ts`, `packages/mcp/src/instructions.ts`
- Modify: `packages/mcp/src/server.ts` (`new McpServer({…}, { instructions: SERVER_INSTRUCTIONS })` + registrazione dei tool nuovi), `packages/mcp/src/tools/shared.ts:69` (messaggio senza `/stubwise:init`), `packages/mcp/src/tools/write.ts` (`create_backlog_item`: progetto col backlog spento → ticket `feature`; esito fuso), `packages/mcp/src/notices.ts` (testi leggibili)
- Test: `packages/mcp/src/tools/docs.test.ts`, `tools/requests.test.ts`, `tools/write.test.ts`, `tools/shared.test.ts`, `server.test.ts`, `notices.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces (tool):
  - `search_project_docs { project: string; query: string }` → elenco numerato dei passaggi (titolo, repository, testo, `repositoryId` + `slug` per approfondire); nessun passaggio → lo dice esplicitamente («la documentazione non ne parla»).
  - `read_doc_page { repositoryId: string; slug: string }` → testo della pagina, **troncato a 30.000 caratteri** con una riga finale «(pagina troncata: …)».
  - `my_requests { project?: string; status?: "open" | "all" }` → bug (ticket con `mine`) e richieste (voci con `mine`) dell'utente, ognuno con stato in parole semplici:
    - ticket: `open`/`triaged` → «ricevuta, non ancora presa in carico»; `in_progress` → «in lavorazione»; `in_review` → «in verifica»; `done` → «rilasciata»; `closed` → «chiusa».
    - voce: `new` → «ricevuta»; `refining` → «in valutazione»; `ready` → «pronta per essere sviluppata»; `converted` → «in sviluppo (ticket #N)» + stato del ticket; `archived` → «archiviata».
    - default `status: "open"` (esclude done/closed/archived).
    - per i ticket, gli ultimi 3 commenti umani (non eliminati) in coda alla riga, perché l'agente possa riassumere le note del maintainer.
  - `SERVER_INSTRUCTIONS: string` (≤ ~1.500 parole, italiano): il flusso dello spec («Il flusso di bug e richieste» punti 1-6) **verbatim nei contenuti**, la regola del progetto (intuire, chiedere sempre conferma, poi tenerlo), le risposte sui Docs scritte da te a partire da `search_project_docs`/`read_doc_page` citando la pagina, mai inventare se i Docs non coprono; registro semplice, niente gergo né comandi da terminale salvo che l'utente sia uno sviluppatore che lavora su un repository; cosa dire quando una richiesta è fusa; per un bug usare `create_ticket` con `type: "bug"`, per una richiesta `create_backlog_item`; dentro un repository collegato a Stubwise valgono anche le regole della skill `stubwise`.
  - `create_backlog_item`: se il progetto ha `backlogEnabled === false` crea un ticket `feature` e lo dice; se la voce risultante ha `createdAt` precedente all'invio → «la tua richiesta è stata unita a una simile già aperta: «<titolo>»».
  - messaggio di `resolveProject` senza progetto: «Non so di quale progetto parli: indica il progetto (vedi `list_projects`) e chiedi conferma all'utente.»

- [ ] **Step 1: test falliti**: `server.test.ts` — `McpServer` creato con `instructions` non vuote che contengono «chiedi conferma» e non contengono `/stubwise:init`; `docs.test.ts` — passaggi resi con `repositoryId`/`slug`, zero passaggi → frase esplicita, pagina di 40.000 caratteri → troncata a 30.000 con avviso; `requests.test.ts` — mappatura di ogni stato sopra (tabella guidata), voce `converted` mostra il ticket, default esclude chiusi, un ticket con un commento eliminato non lo mostra; `write.test.ts` — progetto col backlog spento → `createTicket` con `type: "feature"`, voce fusa → messaggio di unione; `shared.test.ts` — il messaggio senza progetto non contiene `/stubwise:init`; `notices.test.ts` — gli avvisi non contengono `rm -rf`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** implementare.
- [ ] **Step 4:** `pnpm --filter @stubwise/mcp test && pnpm --filter @stubwise/mcp typecheck && pnpm --filter @stubwise/mcp build` → PASS.
- [ ] **Step 5: commit** `feat(mcp): domande sui Docs, le mie richieste e istruzioni per i collaboratori`.

### Task 7: Plugin, skill e rilascio

**Files:**
- Modify: `plugins/stubwise/skills/stubwise/SKILL.md` (solo la `description` del frontmatter: limitarla al lavoro su un repository collegato a Stubwise — piani, design, `docs/plans/`, ticket del repo — così non scatta in una conversazione da collaboratore; nessun altro cambio), `plugins/stubwise/.mcp.json` invariato salvo la versione (la riscrive lo script)
- Create: `.changeset/mcp-collaboratori.md` — `"@stubwise/mcp": minor`, `"@stubwise/claude-plugin": minor`, testo italiano
- Test: `packages/mcp/src/plugin-version.test.ts` (già esistente: deve restare verde), `node packages/mcp/scripts/check-plugin-changeset.mjs`

- [ ] **Step 1:** modificare la descrizione della skill e aggiungere il changeset.
- [ ] **Step 2:** `node packages/mcp/scripts/check-plugin-changeset.mjs` → exit 0; `pnpm --filter @stubwise/mcp test -- plugin-version` → PASS.
- [ ] **Step 3: commit** `feat(plugin): la skill dei repository non scatta per domande e richieste`.

### Task 8: Web — sezione «Claude Code» nelle impostazioni

**Files:**
- Create: `apps/web/src/routes/settings/claude-code.tsx`, `apps/web/src/routes/settings/claude-code.test.tsx`
- Modify: `apps/web/src/routes/settings/layout.tsx:18` (`{ to: "/settings/claude-code", labelKey: "claudeCode", adminOnly: false }`), `apps/web/src/router.tsx` (~105, ~889, ~1060), `apps/web/src/i18n/locales/{it,en}.json` (`settings.nav.claudeCode`, `settings.claudeCode.*`), `apps/web/src/routes/settings/access-tokens.tsx` (estrarre `CreateTokenForm` per riusarlo, se serve)

**Interfaces:**
- Consumes: `createPat(name, expiresAt)` (`apps/web/src/lib/api.ts:296`), `useCopyWithFallback`.
- Produces: `buildInstallCommand(url: string, token: string): string` (esportata, pura) =
  `npx -y @stubwise/mcp setup --url <url> --token <token> && claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise`
  con `url` = `window.location.origin`. La pagina: tre righe di spiegazione (serve Claude Code, serve Node — link a nodejs.org —, il comando si vede una volta sola), bottone «Crea il comando» (crea un PAT di nome «Claude Code») → mostra il comando con «Copia»; sotto, cosa chiedere a Claude («Come funziona…», «Ho trovato un problema…», «Vorrei poter…», «A che punto sono le mie richieste?»).

- [ ] **Step 1: test falliti**: `buildInstallCommand` produce esattamente la stringa sopra; la pagina dopo «Crea il comando» chiama `createPat` e mostra un comando che contiene il token; il link di navigazione esiste per un member.
- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- claude-code` → FAIL.
- [ ] **Step 3:** implementare.
- [ ] **Step 4:** test, typecheck, build del web → PASS.
- [ ] **Step 5: commit** `feat(web): la sezione Claude Code genera il comando d'installazione`.

### Task 9: Guida, documentazione interna, deploy-log

**Files:**
- Create: `apps/docs/src/content/docs/getting-started/claude-code.md` (per i collaboratori: installazione dal web, cosa chiedere, cosa succede a bug e richieste, come seguirle)
- Modify: `CLAUDE.md` (sezione «Integrazione Claude Code (MCP)»: tool nuovi, `instructions`, file di configurazione, `setup`, avviso `request.created`), `docs/operations/deploy-log.md` (voce «MCP per i collaboratori»: migrazioni 0092 e 0093, `notification_kind` nuovo ⇒ server non scende d'immagine finché ne esistono righe, ordine server → worker → caddy, rilascio dell'MCP e del plugin via PR di versioning, reinstallazione dell'app)

- [ ] **Step 1:** scrivere le tre parti.
- [ ] **Step 2:** `pnpm --filter @stubwise/docs build` → PASS.
- [ ] **Step 3: commit** `docs: Claude Code per i collaboratori — guida, CLAUDE.md, deploy-log`.

### Task 10: Verifica finale

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` dalla radice → tutto verde (Docker acceso solo per questo, poi fermato).
- [ ] Prova manuale dell'MCP: `node packages/mcp/dist/index.js setup …` verso un server locale, poi Claude Code in una cartella **senza** repository: «come funziona X in <progetto>?», «ho trovato un problema…», «a che punto sono le mie richieste?» — nessun riferimento a `/stubwise:init`, conferma del progetto chiesta, bozza mostrata prima di aprire.
