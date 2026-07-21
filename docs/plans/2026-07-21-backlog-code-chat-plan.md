# Sessione di analisi sul codice nella chat backlog — Piano di implementazione

> **For Claude:** eseguito con subagent-driven development (implementer Opus +
> spec review + quality review per blocco). Design di riferimento (LEGGERLO
> PRIMA): `docs/plans/2026-07-21-backlog-code-chat-design.md`.

**Goal:** chat di refinement a doppia modalità — RAG docs (com'è) + sessione
persistente dell'agente claude CLI sul worktree del repo (read-only), stile
Claude Code headless.

**Worktree:** `.worktrees/backlog-code-chat`, branch `feature/backlog-code-chat`.

**Regole trasversali:** TDD; testcontainers per db/server/worker (Docker
attivo); i18n SEMPRE en+it (parity test); `pnpm lint` (root) prima del merge;
commit in italiano conventional-commits col trailer di sessione.

---

## Blocco 1 — Server + DB

**Files:**
- Modify: `packages/shared/src/schemas/backlog.ts` — `backlogJobKindSchema`
  + `"chat_turn"`; `backlogJobPayloadSchema` esteso con la forma strict
  `{itemId, userMessageId}`; schemi sessione: `backlogCodeSessionStatusSchema`
  (`active|closed`), `startCodeSessionSchema` (`{repositoryId: uuid}`).
- Modify: `packages/db/src/schema.ts` — tabella `backlog_code_sessions`
  (id pk, item_id FK cascade, repository_id FK, status default active,
  cli_session_id text null, started_at/last_activity_at defaultNow,
  closed_at null) + **unique parziale** su item_id `WHERE status='active'`.
- Create: `packages/db/drizzle/0055_*` — ALTER TYPE backlog_job_kind ADD
  VALUE 'chat_turn' + CREATE TABLE + indici. ⚠️ Trappola batch-tx: il valore
  nuovo NON va usato da altri statement della stessa migrazione (qui nessuno).
- Modify: `apps/server/src/routes/backlog.ts` (o nuovo modulo registrato
  accanto): endpoint sessione + chat dual-mode + GET esteso.
- Test: `packages/db/src/backlog.test.ts` (migrazione + unique parziale),
  `apps/server/src/routes/backlog.test.ts` / `backlog-chat.test.ts`.

**Endpoint:**
- `POST /:id/code-session` (requireAuth) `{repositoryId}` → 201 sessione;
  400 repo estraneo al progetto; 409 item converted/archived o sessione già
  active; messaggio system i18n (content language dell'istanza) "sessione
  avviata su <repo>".
- `DELETE /:id/code-session` → 200 closed + closed_at + messaggio system;
  404 senza active.
- `POST /:id/chat` con sessione active → persiste user message, accoda
  `backlog_jobs {kind: chat_turn, payload: {itemId, userMessageId}}`,
  touch `last_activity_at`, risposta `202 {mode:"code"}` senza SSE.
  Senza sessione → SSE RAG INVARIATO (test esistenti verdi).
- `GET /:id` → `codeSession: {status, repositoryId, startedAt} | null`
  (l'active) e `pendingTurn: boolean` (chat_turn queued/running, pattern
  deepDivePending).

**Test richiesti:** start 201+system+409 doppio+400 repo estraneo+409 su
converted; stop 200+system+404; chat code-mode 202 + user persistito + job col
payload esatto + niente SSE; chat senza sessione invariata; GET con
codeSession/pendingTurn; unique parziale (closed+active ok, doppia active no).

## Blocco 2 — Worker

**Requisiti aggiunti dalla review del Blocco 1 (obbligatori):**
- **Serializzazione per-item dei chat_turn**: due turni della stessa voce non
  devono mai girare in parallelo (un `--resume` concorrente della stessa
  sessione CLI, o doppia creazione sessione al primo turno). Serializer
  keyed per itemId (pattern createProjectSerializer) nel fast poller.
- **Turno orfano = fallimento morbido**: chat_turn la cui sessione non è più
  active → job done no-op silenzioso (niente errore rumoroso): la race col
  DELETE è ammessa dal server.
- **`sessionId` nel payload** del chat_turn (il server lo mette — coordinato
  col fix del Blocco 1): il turno risponde NELLA sessione in cui è stato
  posto; se la sessione del payload non è più quella active → no-op (evita
  risposte sul repo sbagliato dopo chiusura+riapertura).
- **Tiebreaker nel claim**: `ORDER BY created_at, id` (l'ordine dei turni
  conta).
- **Convert chiude la sessione**: valutato e DECISO — la conversione di una
  voce chiude l'eventuale sessione active con messaggio system (fix piccolo
  lato server nel Blocco 2 o ripreso qui; scegliere e dichiarare).

**Files:**
- Modify: `apps/worker/src/agent/runner.ts` — `AgentRunOptions.resumeSessionId?:
  string`; il risultato del run espone `sessionId` (dal JSON del CLI).
- Modify: `apps/worker/src/agent/claude-cli.ts` — arg `--resume <id>` quando
  presente; parsing del `session_id` dall'output JSON (verificare il campo
  reale emesso dal CLI; parse difensivo, null se assente).
- Modify: `apps/worker/src/backlog/poller.ts` — `claimNextBacklogJob` filtra
  `kind IN ('intake','deep_dive')` (il poller 20s NON claima i turni);
  export di un claim dedicato per `chat_turn`.
- Create: `apps/worker/src/backlog/code-session.ts` — registry in-memory
  (pattern generationRegistry): `itemId → {dir, cliSessionId, repositoryId,
  lastUsed}`; apertura pigra del worktree a HEAD default branch (openWorktree
  del MirrorManager DENTRO il serializer per-progetto; i turni successivi
  NON passano dal serializer); sweep TTL (`BACKLOG_CHAT_SESSION_TTL_MINUTES`,
  default 30): active scadute → closed + messaggio system i18n + worktree
  rimosso; rimozione worktree anche su DELETE (sessione closed trovata al
  turno o allo sweep) e best-effort allo shutdown.
- Create: `apps/worker/src/backlog/chat-turn.ts` — `runChatTurn(deps, job)`:
  1. carica job payload validato, sessione (se non active → job done no-op,
     nessuna risposta), messaggio user;
  2. entry del registry o ri-bootstrap (worker riavviato): riapri worktree,
     NUOVA sessione CLI ri-innescata con prompt di priming (documento +
     metadati + ultimi N messaggi dal DB, N≈20, cap caratteri);
  3. primo turno: run `-p` col prompt di priming + domanda; successivi:
     `--resume cliSessionId` con la sola domanda;
  4. `permissionMode: "plan"`, `maxTurns` `BACKLOG_CHAT_TURN_MAX_TURNS`
     (default 15), `timeoutMs` `BACKLOG_CHAT_TURN_TIMEOUT_MS` (default
     300000), provider come intake (`resolveBacklogProvider`);
  5. risposta → insert messaggio assistant; `cli_session_id` e
     `last_activity_at` aggiornati;
  6. errore/timeout → messaggio assistant di errore i18n + job FAILED senza
     retry (la domanda resta in chat, l'utente può rimandarla).
- Create: `apps/worker/src/backlog/chat-turn-poller.ts` — poller veloce
  (`BACKLOG_CHAT_TURN_POLL_SECONDS`, default 2, 0=off): claim dedicato,
  recovery orfani (running stantii → failed, niente retry), niente
  sovrapposizione tick (pattern poller esistente).
- Modify: `apps/worker/src/config.ts` + `apps/worker/src/index.ts` +
  `.env.example` + `docker-compose.yml` — le 4 env del design, wiring del
  poller e dello sweep, checklist env completa.
- Modify: `packages/i18n/src/catalog.ts` — chiavi en+it per i messaggi
  system/errore del worker.
- Test: runner (--resume arg, sessionId parse), claim per kind (il poller
  lento NON prende chat_turn e viceversa), chat-turn (primo turno con priming
  → assistant + cli_session_id salvato; resume col session id; sessione
  closed → no-op; errore → messaggio errore + failed no-retry; ri-bootstrap
  dopo registry vuoto), sweep TTL, config.

## Blocco 3 — Web

**Files:**
- Modify: `apps/web/src/lib/api.ts` — tipi `BacklogCodeSession`, campi
  `codeSession`/`pendingTurn` su `BacklogItemDetail`; funzioni
  `startCodeSession(id, repositoryId)`, `stopCodeSession(id)`; `postBacklogChat`
  non-SSE? NO: il POST è lo stesso endpoint — in modalità code la risposta è
  202 JSON; estendi `postBacklogChatStream` o aggiungi `postBacklogChatTurn`
  (scelta motivata: due funzioni esplicite è più chiaro).
- Modify: `apps/web/src/components/backlog-chat.tsx` —
  - badge modalità nell'header del pannello (DOCS / CODE — nome repo);
  - pulsante "Avvia sessione di analisi" (repo picker se >1, riusa il pattern
    della dialog deep-dive) / "Chiudi sessione";
  - in modalità code: invio → POST turn → bolla assistant placeholder "sta
    investigando nel codice…" finché la risposta non arriva;
  - **merge dei messaggi server per id non visti**: la chat integra i
    messaggi nuovi dal GET dettaglio (risposte dei turni E system del
    refresh/deep-dive — chiude il follow-up noto) senza duplicare gli append
    locali (gli id server dei messaggi locali non coincidono: dedup per id
    server + euristica su contenuto per il proprio ultimo user message,
    scelta documentata);
  - polling del dettaglio a 2s mentre `pendingTurn` (pattern refetchInterval
    condizionale già usato per deepDivePending — coordinato dal chiamante
    $id.tsx).
- Modify: `apps/web/src/routes/backlog/$id.tsx` — refetchInterval anche su
  pendingTurn; props nuove alla chat.
- i18n en+it. Test: pattern docs-chat/backlog-chat esistenti (fetch mock):
  avvio sessione (picker, POST), invio in modalità code (202 + placeholder +
  arrivo risposta via refetch mockato), merge senza duplicati, chiusura,
  badge modalità, RAG invariata senza sessione.

## Verifica finale e merge

1. `pnpm typecheck` + `pnpm lint` + `pnpm test` (radice) + `pnpm build` verdi.
2. Verifica runtime reale in prod dopo deploy (sessione su un item Golli,
   domanda che richiede il codice, risposta fondata; read-only: nessun file
   modificato nel worktree).
3. Merge --no-ff su main; deploy: migrazione 0055, rebuild
   server+worker+caddy INSIEME.

## Rischi noti

- Campo `session_id` nell'output JSON del CLI: da verificare sul formato
  reale della versione installata nel container worker (fallback: se assente,
  ogni turno ri-primed — degradato ma funzionante; loggare warning).
- Latenza percepita: primo turno 30–60s; mitigata dal messaggio di stato in
  UI. Streaming dei turni = evoluzione successiva (fuori scope).
- Worktree persistenti + riavvio worker: le sessioni NON bloccano il riavvio
  (ri-bootstrap trasparente) — nessun nuovo vincolo operativo.

## Follow-up noti (dalle review, non bloccanti)

- **Falso-orfano pre-ingresso per pileup 3+ same-item**: un turno reclamato ma
  accodato dietro 3+ turni della stessa voce (ognuno ~timeout) può superare la
  soglia `2×timeout+5` mentre è ancora IN CODA (started_at al claim, non ancora
  rinfrescato) → recovery lo marca failed + messaggio d'errore, poi il turno gira
  comunque (runFn non gatea sul refresh) e scrive la risposta reale → doppio
  messaggio benigno (completeChatTurnJob è status-guarded, job resta failed).
  Non corruttivo, nessuna perdita dati né doppio --resume. Scenario irrealistico
  in uso normale: la UI blocca l'invio di un 2° messaggio code finché il turno è
  in volo (guardia turnInFlight), quindi il pileup richiede API dirette o più tab.
  Tensione di design intrinseca (il claim DEVE settare started_at per recuperare
  un worker morto prima dell'ingresso). Se mai un problema: heartbeat sul turno in
  esecuzione, o recovery consapevole della sessione in-memory attiva.
- Estrazione della logica di merge/dedup della chat web (`isReconciliation`,
  effetto di riconciliazione) in un modulo testabile in isolamento (backlog-chat
  è ~730 righe).
