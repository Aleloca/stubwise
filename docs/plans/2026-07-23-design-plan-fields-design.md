# Design doc & piano di implementazione su backlog e ticket

Data: 2026-07-23
Stato: design validato, pronto per il piano di implementazione

## Obiettivo

Permettere di **salvare su una voce di backlog o su un ticket** due artefatti prodotti
durante il refinement (tipicamente da Claude Code):

1. un **design doc**, che **sostituisce il corpo principale** dell'entità (così la
   "verità corrente decisa" è sempre nel corpo, senza discordanze con la richiesta
   iniziale);
2. un **piano di implementazione**, in un **campo dedicato**, rigenerabile in modo
   indipendente dal design (se in futuro si riprende l'item e il codice è cambiato,
   si riscrive solo il piano).

Con **CRUD completo** (genera/salva, modifica, elimina) e valido **sia per il
backlog sia per i ticket direttamente** (si può partire da un ticket, salvarci un
design e poi un piano).

Nasce da un buco emerso usando l'integrazione MCP: partendo da una voce di backlog
esistente e producendo design+piano in locale, non c'era modo di riportarli DENTRO
la voce di Stubwise (i tool MCP creano voci nuove o convertono in ticket, ma non
aggiornano il contenuto di una voce esistente; il `document`/`body` non è
modificabile dalle PATCH esistenti).

## Decisioni validate

- **Il design È il corpo**, non un campo nuovo: salvare un design = sostituire
  `document` (backlog) / `body` (ticket) col design.
- **L'originale si preserva a parte, una sola volta**: al primo salvataggio di un
  design, il corpo corrente viene copiato in `origin_content`; da lì gli
  aggiornamenti del design non lo sovrascrivono. `origin_content` è consultabile
  (contesto/audit del "perché"), non è il corpo visibile.
- **Il piano è un campo dedicato** (`implementation_plan`), ortogonale al design.
- **Simmetria backlog ↔ ticket**: stesse operazioni; il convert eredita i campi.
- **Il piano alimenta la pipeline di fix** (ticket): lanciando `run-ai` su un ticket
  con `implementation_plan` salvato, la pipeline **esegue direttamente** col quel
  piano (salta triage, pianificazione AI e approvazione).
- **Naming**: `implementation_plan` distinto da `ai_jobs.plan_text` (il piano
  effimero della pipeline, che resta invariato).

## Modello dati (migrazione 0058)

Due colonne nuove, **su entrambe** le tabelle `backlog_items` e `tickets`:

- `implementation_plan text` (nullable) — il piano di implementazione (Markdown).
- `origin_content text` (nullable) — il corpo originale preservato al primo salvataggio
  di un design.

Il corpo principale resta il campo esistente: `backlog_items.document`,
`tickets.body`. Nota: `tickets.body` alimenta la colonna generata `search_tsv`
(ricerca full-text) → il design diventa ricercabile; `implementation_plan` resta
fuori dalla ricerca (corretto). Prossima migrazione: **0058** (l'ultima è 0057).

**Semantica delete:**
- *elimina design* → `document`/`body` = `origin_content`; `origin_content` = null
  (si esce dallo "stato design"). 404 se non c'è un design attivo.
- *elimina piano* → `implementation_plan` = null.

## Endpoint (server)

Sotto-risorse dedicate, tutte **`requireAuth`** (scrivere design/piani è attività da
sviluppatore; il PAT eredita i permessi utente).

Backlog (`apps/server/src/routes/backlog.ts`):
- `PUT /api/backlog/:id/design` body `{ content }` — preserva `origin_content` se
  null, poi `document = content`.
- `DELETE /api/backlog/:id/design` — `document = origin_content`, `origin_content = null`.
- `PUT /api/backlog/:id/plan` body `{ content }` — `implementation_plan = content`.
- `DELETE /api/backlog/:id/plan` — `implementation_plan = null`.

Ticket (`apps/server/src/routes/tickets.ts`) — identici su `body`/`origin_content`;
il set del design genera un `ticket_event` di audit (riuso `diffTicketEvents`):
- `PUT /api/tickets/:id/design`, `DELETE …/design`, `PUT …/plan`, `DELETE …/plan`.

Validazione `content`: `z.string().min(1).max(20_000)`. Idempotente. I due PUT sono
ortogonali (design non tocca piano e viceversa). Consentiti anche su item
`converted`/ticket `closed` (rifinire un design dopo la conversione è lecito).

**Lettura**: nessun endpoint nuovo — estese le risposte di dettaglio
(`GET /api/backlog/:id`, `GET /api/tickets/:id` e i relativi schemi) con
`implementationPlan` e `originContent`. Le liste restano leggere.

**Convert** (`POST /api/backlog/:id/convert`): esteso per ereditare
`document → body`, `implementation_plan → implementation_plan`,
`origin_content → origin_content`.

## Integrazione col fix (Fase 2)

Vale solo per i **ticket** (la pipeline gira sui ticket; un backlog diventa
eseguibile quando convertito, portandosi il piano).

Oggi `run-ai` fa triage → l'agente genera `plan_text` → commento → `awaiting_plan_approval`
→ approvazione → execute. Esiste già `resumeMode="execute"` che, con `planText`
presente, va dritto in esecuzione (`resolveFixMode`, `apps/worker/src/pipeline/fix.ts:333`).

Modifica: in `POST /api/tickets/:id/run-ai`, se il ticket ha `implementation_plan`,
si accoda un `ai_job` con `resumeMode="execute"` e `planText = implementation_plan`,
stato `queued` → il worker **salta triage/pianificazione/approvazione** ed esegue
col piano salvato. Riusa il percorso di esecuzione esistente, nessuna macchina a
stati nuova.

- **Default**: piano presente → esecuzione diretta (come deciso). Flag opzionale
  `mode: "ai_plan"` per forzare la pianificazione AI classica.
- **Trigger**: pulsante **Run AI** esistente nella UI del ticket. Triggerare il fix
  da Claude Code via MCP resta fuori scope (eventuale tool `run_fix` futuro).
- **⚠️ Rischio**: `execute` finora si raggiungeva solo dopo una fase di
  pianificazione; l'ingresso diretto da `run-ai` è nuovo → da coprire con test
  worker.

## Tool MCP + skill

4 nuovi tool di scrittura in `packages/mcp`, con discriminatore `target`
(`"backlog"` | `"ticket"`):
- `set_design { target, id, content }` → `PUT …/design`.
- `delete_design { target, id }` → `DELETE …/design`.
- `set_plan { target, id, content }` → `PUT …/plan`.
- `delete_plan { target, id }` → `DELETE …/plan`.

Lettura: estesi `get_backlog_item` e `get_ticket` per includere `implementationPlan`
e `originContent`.

Skill `stubwise` — nuovi flussi: design finalizzato → `set_design`; piano finalizzato
→ `set_plan`; rigenerare solo il piano → di nuovo `set_plan`; eliminare →
`delete_design`/`delete_plan`; per i ticket, ricordare che Run AI eseguirà il piano
salvato. Il riferimento nel frontmatter del doc locale resta.

## UI (dettaglio backlog e ticket)

Oggi entrambi rendono il corpo via `<Markdown>` (`backlog/$id.tsx:313`,
`tickets/$id.tsx:321`). Siccome il design è il corpo, quella sezione già lo mostra
(rietichettata "Design / Descrizione").

Aggiunte su entrambe le pagine:
- Sezione **"Piano di implementazione"** — rende `implementationPlan` (Markdown, con
  empty state).
- **"Richiesta originale"** collassabile — se `originContent` è valorizzato.
- Controlli **Elimina design** / **Elimina piano** (conferma a due passi). Export
  markdown include anche il piano.

**Scope UI v1 = visualizzazione + delete.** Creazione/modifica avvengono da Claude
Code (tool MCP). Editor inline nella UI = follow-up. i18n en+it (parità).

## Fasi di implementazione

- **Fase 1 — storage + authoring + visibilità**: migrazione 0058, endpoint CRUD
  design/piano (backlog + ticket), estensione read + convert, 4 tool MCP +
  estensione read tool, skill, UI (render + delete). Consegna il valore centrale:
  "design/piano da Claude Code → visibili in Stubwise per il team".
- **Fase 2 — integrazione col fix**: `run-ai` esegue direttamente col piano salvato
  (hook server + ingresso execute-diretto nel worker + test). Isolata perché
  rischiosa.

## Errori e test

- Errori: 404 su id inesistente; `DELETE /design` senza design attivo → 404;
  `content` > 20k → 400; concorrenza in transazione.
- Test: db (migrazione 0058, convert propaga); server (set preserva origine una
  volta, delete ripristina, set/delete plan, read espone i campi, convert eredita,
  requireAuth, ticket_event di audit); mcp (4 tool con target); worker Fase 2 (execute
  diretto con planText, flusso normale invariato); web (render + delete + parità
  i18n). `pnpm lint` prima del merge.

## Deploy

Migrazione all'avvio server → rebuild `server` + `worker` + `caddy`. MCP via
Changesets (changeset → merge PR "Version Packages" → publish `0.1.3`). Skill
aggiornata copiata in `~/.claude/skills/` per l'uso cross-repo.

## Riferimenti (codice)

- Backlog: `packages/db/src/schema.ts:2014` (`backlogItems`, `document`),
  `apps/server/src/routes/backlog.ts:677` (PATCH, no document), `:1222` (convert),
  `apps/web/src/routes/backlog/$id.tsx:313` (render document).
- Ticket: `packages/db/src/schema.ts:452` (`tickets`, `body`, `search_tsv`),
  `apps/server/src/routes/tickets.ts:936` (PATCH body), `:1094` (approve-plan),
  `apps/web/src/routes/tickets/$id.tsx:321` (render body).
- Piano pipeline esistente: `packages/db/src/schema.ts:682` (`ai_jobs.plan_text`),
  `apps/worker/src/pipeline/fix.ts:333` (`resolveFixMode`).
- Pattern append sezione (riferimento): `apps/worker/src/backlog/deep-dive.ts:123`.
