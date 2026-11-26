# Integrazione area 10, F8 — «/» e «#»: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F8 — «/» e
> «#»». Specifica: il prototipo (`domain/claude/intents/status.ts` e
> `today.ts`). Invarianti: CLAUDE.md (le rotte letterali prima di quelle
> parametriche), `permissions.md` («Gli elenchi filtrano nella WHERE»).
> Branch: `feat/area10-f8` dall'ultima fetta pronta (F8 non usa niente di
> F6 e F7).

## Prima del codice

- **Nessuna [DECIDE].** È tutta lettura, e il prototipo dice cosa rispondere.
- **Ruling («me» nella lista delle task)**: `read_my_week` deve chiedere le
  task di CHI SCRIVE. Il token del turno non dà al ponte il proprio id, e
  `/api/auth/me` non è nell'allowlist (e non ci deve entrare: dà la sessione
  intera). La lista delle task accetta quindi `assigneeIds=me`, come le
  decisioni accettano già `askedOfId=me` (`packages/api-client`
  `decisions.ts`): il server lo risolve sull'utente della richiesta. È un
  valore in più, additivo, per tutti i client. Se sbagliato costa un
  parametro.
- **Fatti del codice che contano**:
  - `/status`: il prototipo legge i progetti fissati (o, se non ce ne sono,
    tutti quelli visibili), con il polso e la prima riga del brief se il
    messaggio nomina un progetto. Nel vero i fissati sono i seguiti
    (`GET /api/me/follows`, già filtrati sui progetti visibili) e il polso è
    `GET /api/projects/pulse` (con `needsViewer`, lo stesso ordine del
    prototipo: prima chi aspetta te). Il brief c'è già
    (`/api/projects/:projectId/briefs/latest`);
  - `/today`: le decisioni che aspettano chi scrive
    (`GET /api/decisions?askedOfId=me&open=true`), le sue task in ritardo o
    in scadenza oggi, poi il resto della sua settimana
    (`GET /api/tasks?assigneeIds=me&families=todo,active`). «Oggi» e la
    settimana corrente sono nel fuso Europe/Rome, la regola di
    `docs/invariants/tasks.md`;
  - le skill dei plugin in «/»: il renderer legge
    `GET /api/projects/:projectId/plugins` (accesso `member`, la rotta
    c'è). Nessun lavoro del server;
  - «#» con le richieste: il renderer cerca anche le richieste
    (`GET /api/requests?projectId=…`), e `read_request` c'è già. Nessun
    lavoro del server.

## Regole di lavoro (le solite)

Come F5. Nel giro anche `chat-tool-token.test.ts`, `bridge.test.ts`,
`prompts.test.ts`, i test della lista delle task e delle decisioni.

## Task 1 — «me» nella lista delle task (shared, server)

**File**: shared `schemas/task-view.ts` (`assigneeIds` accetta `me`);
server, la risoluzione nella rotta della lista.

**Test**: `assigneeIds=me` dà le task di chi chiede e nessun'altra, anche
mischiato con altri id; col token del turno dà quelle dell'autore; un
client che non lo manda non cambia.

## Task 2 — i due tool (shared, worker)

**File**: shared (`read_followed_projects`, `read_my_week` in
`CHAT_READ_TOOLS`; `/api/me/follows`, `/api/projects/pulse` e
`/api/decisions` in `CHAT_TOOL_READ_ROUTES`), worker `bridge.ts` (le rotte e
le proiezioni: dalle decisioni solo id, task, domanda e chi chiede; dal
polso i soli campi del riassunto), `prompts.ts` (`STATUS_AND_TODAY_RULE`:
«for /status call read_followed_projects, for /today call read_my_week;
cite the codes; say “nothing” when there is nothing»).

**Test**: `bridge.test.ts` (le proiezioni, `compact` sui campi);
`chat-tool-token.test.ts`: le tre rotte nuove ammesse col token, e
`/api/decisions/:id/answer` NO (è una scrittura: lo si dice in un test
negativo, perché il prefisso è lo stesso).

## Task 3 — i golden e i documenti

1. `chat-status` («/status»): legge seguiti e polso, cita il progetto che
   aspetta chi scrive per primo. `chat-today` («/today»): legge decisioni e
   settimana, cita la decisione aperta e la task in ritardo. Nessuna
   proposta in entrambi. 3 volte ciascuno, quando autorizzati.
2. `deploy-log.md`: nessuna migrazione. ORDINE: server, poi worker, poi
   caddy. Rollback sicuro (un worker vecchio non ha i tool; un server vecchio
   rifiuta `assigneeIds=me` con 400, e il tool lo dice).
3. `integration-claude-chat.md`; nel registro dei rimandi restano le
   citazioni sui messaggi della conversazione (anche di file, area 5 D6) e
   gli allegati (`claude-attachments`), come dice il design.
4. La voce di deploy-log per l'AREA (il design: «una voce per l'area,
   scritta all'ultima fetta»), con l'ordine delle migrazioni di tutte le
   fette e le discese non sicure (`member.added`, `aside`, `capabilities`).

## Per 94 (renderer)

- «/status» e «/today» scrivono il comando nel messaggio: è il modello a
  chiamare i tool.
- Le skill in «/» e le richieste in «#» sono letture del renderer sulle
  rotte che ci sono.

## Review Focus

- I tool leggono SOLO ciò che chi scrive vede (le rotte filtrano già:
  nessun filtro nel ponte da cui dipendere).
- Nessuna rotta di scrittura entra nell'allowlist per prefisso.
- «me» si risolve sul server, mai nel client.
