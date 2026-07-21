# Backlog: sessione di analisi sul codice nella chat di refinement — design

Data: 2026-07-21 · Stato: validato con l'utente, da implementare

## Problema

La chat di refinement è RAG-only sulla documentazione: quando la documentazione
non copre l'argomento (caso reale segnalato dall'utente) l'agente non può
rispondere, anche se la risposta è nel codice. L'utente vuole l'esperienza
Claude Code: l'agente investiga il repo in diretta.

## Soluzione (approvata)

**Doppia modalità nella stessa conversazione:**
- Default: chat RAG streaming sulla documentazione (com'è oggi) — risposte
  istantanee.
- Pulsante **"Avvia sessione di analisi"** (scelta repo se il progetto ne ha
  più d'uno): da lì in poi ogni messaggio è un turno dell'agente claude CLI
  **headless con sessione persistente** (`-p` + `--resume <session_id>`) su un
  worktree read-only del repo. La sessione CLI mantiene il contesto tra i
  turni (il modello ricorda cosa ha già esplorato → turni successivi più
  rapidi). Niente PTY/TUI: solo invocazioni headless.
- **Read-only a due livelli**: `--permission-mode plan` (solo Read/Grep/Glob,
  come la PR review) + worktree usa-e-getta mai pushato, senza `.env`
  materializzati.
- **Persistenza invariata**: tutti i messaggi (entrambe le modalità) in
  `backlog_chat_messages`; "Aggiorna documento" sintetizza da tutta la
  conversazione. Messaggi `system` marcano avvio/chiusura sessione.

## Architettura

### DB (migrazione 0055)
- Nuovo valore enum `backlog_job_kind`: `chat_turn` (⚠️ trappola batch-tx:
  ALTER TYPE ADD VALUE non usabile nella stessa migrazione — qui nessun uso,
  solo ADD VALUE; nessun seed).
- Nuova tabella `backlog_code_sessions`: `id`, `item_id` (FK cascade, UNIQUE
  parziale sulle attive), `repository_id` (FK), `status` (`active|closed`),
  `cli_session_id` (text null — assegnato dal primo turno), `started_at`,
  `last_activity_at`, `closed_at`.
- Payload `chat_turn`: `{ itemId, userMessageId }` (il worker legge il
  contenuto dal messaggio persistito). Union zod estesa in shared.

### Server
- `POST /api/backlog/:id/code-session` `{repositoryId}` (auth): valida repo
  del progetto, 409 se già attiva; crea riga `active` + messaggio system
  ("sessione di analisi avviata su <repo>") → 201. Nessun lavoro worker
  all'avvio: il worktree si apre pigramente al primo turno.
- `DELETE /api/backlog/:id/code-session`: → `closed` + messaggio system.
- `POST /api/backlog/:id/chat`: se sessione attiva → persiste il messaggio
  user, accoda `chat_turn`, risponde `202 {mode:"code"}` (niente SSE);
  altrimenti percorso SSE RAG invariato.
- `GET /api/backlog/:id`: espone `codeSession: {status, repositoryId} | null`
  e `pendingTurn: boolean` (chat_turn queued/running per l'item).

### Worker
- **Runner**: `AgentRunOptions.resumeSessionId?: string` → arg `--resume <id>`;
  il risultato espone `sessionId` (già presente nel JSON del CLI).
- **Claim per kind**: il poller backlog esistente (20s) claima SOLO
  intake/deep_dive; nuovo poller VELOCE (`BACKLOG_CHAT_TURN_POLL_SECONDS`,
  default 2s) claima solo `chat_turn` (query sull'indice parziale queued —
  costo trascurabile). Stessi meccanismi: attempts, recovery, serializer
  per-progetto NON usato per i turni (un turno non tocca il mirror condiviso
  se il worktree è già aperto; l'APERTURA del worktree sì → dentro serializer).
- **Registry sessioni in-memory** (pattern generationRegistry): `itemId →
  {dir, cliSessionId, repositoryId, lastUsed}`. Primo turno: apre il worktree
  a HEAD del default branch (openWorktree via serializer), run `-p` senza
  resume con prompt di priming (documento + metadati + ultimi N messaggi +
  domanda), salva `cli_session_id`. Turni successivi: `--resume` con la sola
  domanda. Risposta → insert messaggio assistant.
- **Resilienza**: worker restart → registry vuoto; al turno successivo
  ri-apre il worktree e avvia una NUOVA sessione CLI ri-innescata con la
  storia recente dal DB (trasparente; `cli_session_id` aggiornato).
- **Sweep TTL**: sessioni `active` con `last_activity_at` più vecchio di
  `BACKLOG_CHAT_SESSION_TTL_MINUTES` (default 30) → `closed` + worktree
  rimosso + messaggio system ("sessione scaduta per inattività").
- Turno: `permissionMode: "plan"`, `maxTurns` dedicato (default 15),
  `timeoutMs` `BACKLOG_CHAT_TURN_TIMEOUT_MS` (default 300000). Errore/timeout
  del turno → messaggio assistant di errore (i18n) + job failed (un turno NON
  si retry-a: la domanda resta in chat, l'utente può rimandarla).

### Web
- Pannello chat: badge modalità ("DOCS" / "CODE — <repo>"); pulsante "Avvia
  sessione di analisi" (picker repo se >1) / "Chiudi sessione"; in modalità
  code l'invio fa POST e mostra "sta investigando nel codice…" finché arriva
  la risposta.
- **Merge dei messaggi server**: la chat oggi copia `initialMessages` una
  volta; ora integra i messaggi del GET dettaglio con id non ancora visti
  (necessario per ricevere le risposte dei turni; chiude anche il follow-up
  noto sui messaggi system del refresh). Polling del dettaglio (2s) mentre
  `pendingTurn`.
- i18n en+it per tutte le stringhe nuove.

### Config/env (worker)
`BACKLOG_CHAT_TURN_POLL_SECONDS` (2), `BACKLOG_CHAT_SESSION_TTL_MINUTES` (30),
`BACKLOG_CHAT_TURN_TIMEOUT_MS` (300000), `BACKLOG_CHAT_TURN_MAX_TURNS` (15).
Checklist solita: .env.example, envSchema, WorkerConfig, load, compose, wiring.

### Deploy
Migrazione 0055 all'avvio server; rebuild server+worker+caddy insieme (il
server accoda chat_turn che solo il worker nuovo consuma → stesso treno).

## Blocchi di implementazione (subagent-driven, review doppia per blocco)

1. **Server+DB**: migrazione 0055, shared (kind + payload union + schemi
   sessione), endpoint code-session start/stop, chat dual-mode, detail con
   codeSession/pendingTurn, test testcontainers.
2. **Worker**: runner resume+sessionId, claim per kind, fast poller chat_turn,
   registry sessioni + worktree lazy + priming/resume, sweep TTL, recovery
   restart, config+wiring, test.
3. **Web**: stati del pannello chat, merge messaggi server per id, polling
   pendingTurn, picker repo, i18n, test.
