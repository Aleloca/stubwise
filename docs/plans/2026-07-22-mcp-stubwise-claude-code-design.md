# Integrazione Claude Code ↔ Stubwise via server MCP

Data: 2026-07-22
Stato: design validato, pronto per il piano di implementazione

## Obiettivo

Dare a Claude Code (CLI/desktop/IDE, sul PC di ogni sviluppatore) la capacità di
parlare direttamente con un'istanza Stubwise, così che backlog e ticket restino
sincronizzati con il lavoro di design/implementazione fatto in locale. Casi d'uso
guida (non esaustivi):

1. **Design/piano → backlog.** Quando in locale si crea un documento di design o
   un piano di implementazione, viene anche creato un item nel backlog del
   progetto Stubwise, visibile agli altri sviluppatori. Il doc locale riporta il
   riferimento all'item di backlog creato.
2. **Avvio piano con backlog esistente.** Se il piano nasce da un item di backlog,
   all'avvio dell'esecuzione l'item viene convertito in ticket e messo
   `in_progress`; a implementazione finita passa `in_review`; a rilascio avvenuto
   passa `done`. Il doc locale riporta il riferimento al ticket.
3. **Avvio piano senza backlog.** Se non esiste un item di backlog collegato, si
   crea direttamente un ticket `task` con il piano come descrizione e lo si mette
   `in_progress`. Il doc locale riporta il riferimento al ticket.
4. **Consultazione backlog.** Da Claude Code si può chiedere "cosa c'è in backlog
   che potremmo fare?" e ricevere gli item aperti del progetto come spunti.
5. **Note al volo.** Durante design o esecuzione, se emerge un lavoro collaterale,
   si crea un item di backlog per non perderlo.

## Scelte di fondo (validate)

- **Meccanismo: server MCP locale (transport stdio).** È il modo nativo con cui
  Claude Code integra tool esterni. Non è un servizio da tenere acceso: lo avvia
  e lo spegne Claude Code stesso agganciandolo al ciclo di vita della sessione.
- **Distribuzione: pacchetto npm eseguito via `npx`.** Adatto a un progetto
  open-source: il codice è pubblico, la configurazione (`.mcp.json`) è versionata
  nel repo target, le credenziali restano per-utente e fuori dal repo. Gli utenti
  che self-hostano Stubwise puntano il server MCP alla loro istanza via env.
- **Trigger dei passaggi di stato: Claude segue istruzioni** (skill + `CLAUDE.md`),
  non hook rigidi. Trasparente e consapevole del contesto. Il passaggio finale a
  `done` è **on-demand** (vedi sotto), non automatico.
- **Autenticazione: Personal Access Token (PAT)** lato server, modellato sul
  pattern già in prod della chiave `sk_` del monitoring. Token con i **permessi
  dell'utente** a cui è associato (niente scope granulari). Scadenza **opzionale**
  (default infinita, con possibilità di impostarne una).

## Architettura — tre componenti

### 1. `packages/mcp` (nuovo) — il server MCP

Pacchetto npm pubblicabile (`@stubwise/mcp`), eseguibile via `npx`, transport
stdio. È un **adattatore sottile senza logica di business**: espone tool tipizzati
(input validati con Zod, coerente col resto del monorepo) e li traduce in chiamate
HTTP all'API `/api/*` esistente di Stubwise.

Configurazione da ambiente:
- `STUBWISE_URL` — base URL dell'istanza (default: prod, override per self-host).
- `STUBWISE_TOKEN` — il PAT dell'utente, passato via `env` nel `.mcp.json` con
  espansione di variabile (mai valore letterale committato).
- Lo **slug del progetto** viene letto da `.stubwise.json` nella radice del repo.

### 2. Personal Access Token — lato `apps/server` (unico lavoro di dominio nuovo)

- **Formato token:** opaco con prefisso riconoscibile, es. `stw_pat_` + 32 byte
  esadecimali. Mostrato **in chiaro una sola volta** alla creazione; nel DB solo
  l'hash sha256. Riusa `generateServerKey`/`hashServerKey` (`routes/shared.ts`).
- **Tabella `personal_access_tokens`** (nuova migrazione): `id, userId, name,
  tokenHash, lastUsedAt, createdAt, expiresAt (nullable), revokedAt (nullable)`.
- **Verifica:** nuovo preHandler accanto a `requireAuth` in `auth/session.ts`. Se
  arriva `Authorization: Bearer stw_pat_…` → sha256 → lookup su `tokenHash` →
  risolve `request.user` come farebbe la sessione, aggiorna `lastUsedAt`, rifiuta
  se scaduto/revocato (401). In assenza di bearer, ricade sul cookie di sessione
  come oggi. **Nessuna modifica alle route esistenti:** continuano a chiamare
  `requireAuth`, che ora accetta due modi di autenticarsi. Il token eredita i
  permessi dell'utente (un endpoint `requireAdmin` resta inaccessibile a un token
  di non-admin).
- **UI:** sezione "Personal Access Token" nelle impostazioni utente della SPA —
  crea (nome + scadenza opzionale), lista, revoca. Stessa UX del token `sk_` dei
  server.

### 3. Integrazione Claude Code — nel repo target (non in Stubwise)

- **`.mcp.json`** committato: come lanciare il server MCP (`npx -y @stubwise/mcp`)
  e la env `STUBWISE_TOKEN` (espansa dall'ambiente locale).
- **`.stubwise.json`** committato nella radice di ogni repo: `{ "project": "slug" }`.
- **Skill `stubwise`** + poche righe in `CLAUDE.md`: insegnano a Claude *quando*
  usare i tool (i trigger dei 5 flussi).
- **Comando `/stubwise:init`** (vedi sotto).

## Il set di tool MCP (v1)

Pochi, ad alto livello, mappati 1:1 su endpoint già esistenti.

**Lettura**
- `list_projects` → `GET /api/projects` (usato dall'init).
- `list_backlog` → `GET /api/backlog` (filtri stato/urgenza/testo).
- `get_backlog_item` → `GET /api/backlog/:id`.
- `list_tickets` / `get_ticket` → `GET /api/tickets` / `:id`.

**Scrittura**
- `create_backlog_item` → `POST /api/backlog` (asincrono, vedi linking).
- `create_ticket` → `POST /api/tickets` (type `task`).
- `convert_backlog_to_ticket` → `POST /api/backlog/:id/convert` (`requireAdmin`).
- `set_ticket_status` → `PATCH /api/tickets/:id` (stati:
  `open/triaged/in_progress/in_review/done/closed`).

**Fuori dal v1 (aggiungibili dopo):** `run-ai` (avvio pipeline fix AI di
Stubwise), merge, deep-dive, commenti. Il flusso previsto è "sviluppo io in
locale, Stubwise fa da lavagna condivisa": non serve far partire l'agente remoto
da qui.

## Comando `/stubwise:init`

Interattivo (o attivabile in linguaggio naturale, "collega questo progetto a
Stubwise"):

1. Scopre le radici git sotto la cartella aperta: **una sola** repo → un file;
   **cartella-padre con N repo** → un file per ogni radice `.git`.
2. Per ogni repo chiama `list_projects` e chiede a quale progetto Stubwise
   collegarla (repo diverse possono puntare a progetti diversi o allo stesso —
   ricorda che in Stubwise un progetto può avere più repository).
3. Scrive `.stubwise.json` nella radice di ciascuna repo e lo committa.

## Riferimenti incrociati doc ↔ Stubwise

Il doc di design/piano in `docs/plans/` porta nel frontmatter il link alla
controparte Stubwise:

```yaml
stubwise:
  project: acme-web
  backlogItem: 7f3a…      # id + URL cliccabile
  ticket: 142             # numero + URL
```

- **Ticket (casi 2·3):** `convert` e `create_ticket` rispondono **sincroni** con
  `ticketId`/`ticketNumber`. Claude aggiorna subito il frontmatter e committa.
- **Backlog (caso 1) — asincrono.** `POST /api/backlog` non ritorna l'id: accoda
  un job di intake (il worker crea l'item dopo aver girato un agente AI, e può
  fare **auto-merge** su un item simile esistente). Soluzione validata:
  - piccola aggiunta server: `POST /api/backlog` ritorna il `jobId`, e nuovo
    `GET /api/backlog/jobs/:jobId` → `{status, resultItemId}` a lavorazione finita;
  - il tool `create_backlog_item` fa l'enqueue e poi **polling** finché l'intake
    si risolve, quindi ritorna a Claude l'`itemId` reale (gestendo il caso
    "fuso in un item esistente"). Claude scrive il riferimento nel doc.
  - fallback: se l'intake fallisce/va in timeout, il doc viene committato comunque
    con "item in elaborazione, riferimento da aggiornare".

## Passaggi di stato — semantica

- **Avvio esecuzione piano → `in_progress`** — automatico (Claude sa che stai
  iniziando).
- **Implementazione finita → `in_review`** — automatico.
- **Rilascio (PR mergiata / deploy) → `done`** — **on-demand.** Il rilascio
  avviene tipicamente fuori dalla sessione di Claude Code, che non lo "vede
  accadere": lo confermi tu ("ho rilasciato il ticket X, chiudilo").

## Errori e casi limite

- **Manca `.stubwise.json`** → il tool non indovina: chiede di lanciare
  `/stubwise:init`.
- **Token mancante/scaduto/revocato** → 401 → messaggio chiaro per rigenerare
  `STUBWISE_TOKEN`.
- **Permessi insufficienti** (es. token non-admin che chiama `convert`) → 403
  riportato esplicito.
- **Server irraggiungibile** → messaggio con l'URL tentato.
- **Intake backlog fallito/timeout** → doc committato comunque, riferimento
  segnalato come pendente.
- **Slug progetto inesistente** (rinominato lato Stubwise) → suggerisce
  `list_projects` + nuovo `init`.

## Test

- **`packages/mcp`** — unit test con HTTP mockato: per ogni tool, input Zod
  valido/invalido e mappatura sulla chiamata corretta. Il ciclo di vita stdio non
  si testa E2E (lo gestisce Claude Code).
- **`apps/server`** — nuovo preHandler PAT (bearer valido/hash/`lastUsedAt`,
  fallback su cookie, revocato/scaduto → 401) e `GET /api/backlog/jobs/:jobId`,
  con testcontainers come di consueto.
- **Migrazione** `personal_access_tokens` con l'accortezza sul batch-in-una-
  transazione del migratore Drizzle.
- **`pnpm lint`** prima del merge (la CI fallisce su lint anche con typecheck e
  test verdi).

## Superficie API riusata (già esistente)

- `GET /api/projects` — id/slug/flag progetti.
- `GET /api/backlog` (lista+filtri), `GET /api/backlog/:id`, `POST /api/backlog`
  (intake asincrono), `POST /api/backlog/:id/convert` (`requireAdmin`).
- `POST /api/tickets`, `GET /api/tickets` / `:id`, `PATCH /api/tickets/:id`.
- Enum stato ticket: `open, triaged, in_progress, in_review, done, closed`.
- Pattern token `sk_`: `generateServerKey`/`hashServerKey` in `routes/shared.ts`,
  verifica in `routes/monitor.ts`.

## Lavoro server-side nuovo (minimo)

1. Tabella + migrazione `personal_access_tokens`.
2. PreHandler PAT accanto a `requireAuth` in `auth/session.ts`.
3. UI impostazioni utente per creare/listare/revocare PAT.
4. `POST /api/backlog` ritorna `jobId` + nuovo `GET /api/backlog/jobs/:jobId`.

Tutto il resto è adattatore MCP + integrazione Claude Code, senza nuova logica di
dominio.

## Deploy

- **Server MCP** → pubblicazione npm di `@stubwise/mcp` (nessun impatto sul
  compose di Stubwise: gira sui PC degli sviluppatori).
- **Backend** (PAT + endpoint job) → ribuildare `server`; migrazione applicata
  all'avvio; backup DB prima.
- **UI PAT** → ribuildare `caddy` (la SPA è servita da caddy, non dal server).
