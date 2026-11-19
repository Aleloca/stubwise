# Integrazione area 10, F3 — S2 e S3, rispondere sui dati: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F3 — S2 e
> S3» (D-3 = a, D-13 = a). Specifica: il prototipo,
> `domain/claude/intents/stalled.ts` (S2: la risposta, l'ipotesi «fuori
> piano», «Details») e lo scenario S3 della spesa. Invarianti:
> `claude-actions.md` («Gli eventi strutturati li scrive il server»),
> `permissions.md` (R-G5, «Il client legge i permessi calcolati dal
> server»).
> Branch: `feat/area10-f3` da `feat/integrazione-area10`, dopo F2 (che ha
> già riscritto il CHECK degli eventi).

## Prima del codice

- **Nessuna [DECIDE]**: D-3 e D-13 sono decise. L'ipotesi è quella del
  prototipo, una sola.
- **Migrazione 0199** (la 0197 è della review di F1, la 0198 di F2): il CHECK `agent_session_events_type_chk` con `aside`.
- **Fatti del codice che contano**:
  - il polso (`GET /api/projects/pulse`) dà per progetto `stalled[]`:
    `ticketId`, `ticketNumber`, `title`, `stalledSince` (una DATA:
    i giorni li calcola chi mostra), `reason` (`to_prepare`,
    `worked_then_stopped`, `interrupted`, `declared_no_work`). I progetti
    sono quelli che chi guarda VEDE;
  - `title` può venire da fuori: una task nata dal widget o dall'SDK. Il
    prototipo non mostra i titoli in S2, ma codici, giorni e motivi. **La
    proiezione per il modello NON passa `title`**, e così la rotta del polso
    non entra in `CHAT_TOOL_UNTRUSTED_ROUTES`;
  - l'ipotesi del prototipo è UNA: la task ferma più vecchia del primo
    progetto mostrato non è pianificata in nessuna settimana («fuori
    piano»). Il polso non porta la settimana pianificata: la legge chi
    scrive l'`aside`, da `tickets` (lo stato vero dei tickets,
    `docs/invariants/tasks.md`);
  - la spesa: `GET /api/ai-usage/summary?month=true&groupBy=project`.
    Tutta l'istanza con `usage.view`, i soli progetti con
    `project.usage.view`, 403 a chi non ha nessuno dei due
    (`requireUsageScope`). R-G5: un progetto invisibile diventa la riga
    `other`, senza nome;
  - «chi può dirtelo»: `GET /api/access/who-can?permission=usage.view`,
    rotta `user`;
  - il ponte non ha il DB: il worker gli passa i gestori che scrivono
    (`askQuestion` di F2). L'`aside` segue la stessa via, con un gestore del
    worker.

## Regole di lavoro (le solite)

Come F1 e F2. F3 non tocca il catalogo.

## Task 1 — la 0199 e il tipo `aside`

**File**: la migrazione, `meta/_journal.json`, shared `agent-session.ts`.
Test: `migration-0199.test.ts`, il test del parse in shared.

1. **RED**:
   - un evento `aside` si inserisce, e un tipo inventato no;
   - un `readerSchema` vecchio legge `aside` come `UNKNOWN`.
2. **GREEN**: la migrazione e il valore nello `z.enum`.
3. **Mutazione**: togliere `aside` dal CHECK, e il primo test diventa
   rosso.

## Task 2 — `read_stalled_work` e l'`aside`

**File**: shared (`CHAT_READ_TOOLS`, `CHAT_TOOL_READ_ROUTES` con
`/api/projects/pulse`), worker `bridge.ts`, `chat-mcp/server.ts`, un
modulo nuovo `claude-chat/aside.ts` (il gestore che scrive l'evento), server
la lettura degli eventi (dove `proposal` si arricchisce a lettura).
Test: `bridge.test.ts`, `aside.test.ts` (worker, Postgres vero),
`chat-tool-token.test.ts`, il test della lettura degli eventi
(`agent-sessions.test.ts` o quello di `claude-public.test.ts` per le
pubbliche).

1. **RED, ponte**:
   - `read_stalled_work({})` → `/api/projects/pulse`; con `projectId` (uuid
     validato) → lo stesso percorso, e la proiezione tiene solo quel
     progetto;
   - proiezione, per progetto: `projectId`, `code`, `name` e `stalled` come
     `{ code: "<CODE>-<n>", stalledSince, reason }`, più vecchia prima;
   - un `title` nella risposta NON compare nel JSON per il modello.
2. **RED, `aside`** (worker):
   - dopo una risposta 200 con almeno una riga, il gestore scrive un evento
     `aside` con `data: { rows: [{ projectId, ticketId }], hypothesis:
     { ticketId, key: "out_of_plan" } | null }`. Le righe sono quelle
     mostrate, al più 5 progetti;
   - `hypothesis` c'è solo se la più vecchia del primo progetto mostrato non
     ha settimana pianificata;
   - nessuna riga, nessun evento;
   - `data` non porta testo libero (test: niente `title`, niente prosa).
3. **RED, lettura** (server):
   - la vista di un evento `aside` si ARRICCHISCE a lettura, per ogni riga
     ancora visibile a chi guarda: codice della task, codice del progetto,
     `stalledSince` attuale;
   - una riga di un progetto che chi guarda non vede sparisce, e l'ipotesi
     con lei;
   - in una pubblica, un lettore che non è membro del progetto non vede la
     riga;
   - una task chiusa nel frattempo resta, segnata `closed: true`: la
     conversazione racconta quello che era vero allora.
4. **GREEN**: il gestore riceve dal ponte la risposta GIÀ letta (niente
   seconda chiamata) e legge `planned_week` da `tickets` per l'ipotesi. La
   lettura arricchisce in UNA query per pagina.
5. **Mutazioni**:
   - non filtrare la visibilità a lettura: il test della pubblica diventa
     rosso;
   - passare `title`: il test del titolo diventa rosso;
   - scrivere l'ipotesi anche con una settimana pianificata: il test
     dell'ipotesi diventa rosso.
6. **Giro**: `bridge.test.ts`, `aside.test.ts`, `turn.test.ts`,
   `prompts.test.ts` (worker); `chat-tool-token.test.ts`,
   `agent-sessions.test.ts`, `claude-public.test.ts`, `projects.test.ts`
   (server, per il polso); `load-isolated.test.ts`.

## Task 3 — `read_usage_month`

**File**: shared (tool e rotte: `/api/ai-usage/summary`,
`/api/access/who-can`), worker `bridge.ts`, `chat-mcp/server.ts`.
Test: `bridge.test.ts`, `chat-tool-token.test.ts`.

1. **RED, ponte**:
   - i percorsi: `/api/ai-usage/summary?month=true&groupBy=project` e
     `/api/access/who-can?permission=usage.view`;
   - risposta 200: `{ canSee: true, totalUsd, runs, byProject: [{ code,
     label, costUsd }] }`. La riga `other` resta `other`, senza nome;
     niente per persona e niente token;
   - risposta 403: `{ canSee: false, whoCan: [nomi] }`, coi soli nomi
     (niente email) dalla seconda rotta. Il ponte NON tratta il 403 come
     errore del tool.
2. **RED, server**, tre persone sugli stessi dati:
   - con `usage.view` → tutta l'istanza;
   - con `project.usage.view` su un progetto → solo quello, e il resto in
     `other`;
   - senza nessuno dei due → 403 dalla prima rotta e 200 dalla seconda.
3. **GREEN**: la proiezione e il ramo del 403 per questo tool soltanto.
4. **Mutazione**: togliere il ramo del 403, e il test «senza permessi» diventa
   rosso (il tool restituisce un errore invece di `whoCan`). La regola R-G5
   (`other` senza nome) sta nel server e il ponte non la ricalcola: il test
   del server la copre.
5. **Giro**: come il Task 2, più `usage-costs.test.ts` e
   `access-who-can.test.ts`.

## Task 4 — il prompt e i golden S2 e S3

1. Il contratto:
   - per «cosa è fermo», `read_stalled_work`, con il progetto del contesto
     se c'è;
   - l'ipotesi la mostra Stubwise sotto la risposta, e Claude non la ripete
     come certezza;
   - per la spesa, `read_usage_month`. Con `canSee: false` Claude dice chi
     può dirlo, coi nomi di `whoCan`, e non inventa numeri.
2. I golden:
   - `chat-s2-stalled`: due progetti, uno con una ferma fuori piano. Il
     tool è chiamato, e la risposta nomina il codice del progetto e i
     giorni;
   - `chat-s3-usage-denied`: chi non ha permessi. Nessun numero nella
     risposta, e il nome di chi ha `usage.view`;
   - `chat-s3-usage`: con `usage.view`, il totale nella risposta.

   Si lanciano 3 volte ciascuno.
3. **Giro**: `prompts.test.ts`, `turn.test.ts`.

## Task 5 — documenti e chiusura

- `deploy-log.md`: la 0199, e lo stesso rollback di `question` (il CHECK
  non scende finché esistono eventi `aside`).
- `integration-claude-chat.md`: S2 e S3 (per 94).
- Il registro: chiuse «Nessun tool legge il lavoro fermo né i consumi».

## Per 94 (renderer)

- La riga «Hypothesis» e «Details» (`AsideRow`) dall'evento `aside`
  arricchito. La frase dell'ipotesi viene dalla chiave `out_of_plan` più il
  codice della task. «Details» apre la task.
- D-13 = a: il prototipo smette di dare la somma dei propri progetti a chi
  non ha permessi sui consumi.

## Review Focus

- Nessun testo da fuori nel contesto del modello attraverso il polso.
- L'`aside` porta solo id e chiavi; la lettura rifiltra per chi guarda.
- La regola dei consumi resta UNA, nel server: il ponte non la ricalcola.
