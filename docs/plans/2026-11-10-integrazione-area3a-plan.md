# Integrazione area 3, fetta 3a «Guardare» — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** pagina Claude con le sessioni di lavoro vere, riquadro di Claude, sezione Claude del dettaglio completa in lettura e streaming dal vivo, su desktop e `/app`; il prototipo resta invariato.

**Spec:** `docs/plans/2026-11-10-integrazione-area3-claude-design.md`.

## Global Constraints

Quelli dell'area 2, più: branch `feat/integrazione-area3` (parte dall'area 2 completa). Nessuna azione (avvio, piano, domande, scrittura) in questa fetta: tutto in lettura. Le invarianti di `docs/invariants/agent-sessions.md` valgono per intero.

## Review Focus

1. **Stream interrotto** (rete, sleep, 401): ripresa da `?after=` senza eventi doppi né persi.
2. **Sessione di un progetto non visibile** aperta da link: 404, nessun evento.
3. **Molte sessioni aperte**: tetto degli stream per finestra, chiusura delle porte quando si chiude il riquadro o la pagina.
4. **Server vecchio senza i campi nuovi di `/work`**: la sezione degrada, non si rompe.

### Task 3a.1 (shared + server): moduli puri e `/work` esteso
Shared: `sse` (parse dei frame, merge per id, backoff), `sessionEvents` (adattatore server → `ConversationEvent`, selettori), `taskWork` e `prState` spostati dal prototipo con adattatori. Server: `GET /api/tasks/:id/work` esteso con runs, pullRequests e prFacts, `actions` (start, relaunch, resume, requestChanges = allowed|forbidden|unavailable) e `blocked` calcolati dal server con i permessi di chi guarda; filtri delle sessioni per kind/stato/«aspetta me». api-client.

### Task 3a.2 (desktop main): stream via IPC
`src/main/apiStream.ts`: `api:stream-open`/`api:stream-close`, `MessageChannelMain`, allowlist, Bearer, AbortController, parse con il modulo condiviso, tetto 8 per finestra, timeout ping 60 s, `endsSession` sui 401. Preload: `window.stubwise.openStream(path) → MessagePort`. Test con electron mockato.

### Task 3a.3 (renderer): gating e implementazione vera in lettura
`integration.ts`: destinazione `claude` (solo sessioni di lavoro: la chat libera «in arrivo»), riquadro di Claude, sezione Claude del dettaglio completa (azioni nascoste fino alla 3b). `real/claude.ts`: `listConversations`, `getConversation`, `subscribe` (desktop: porta IPC; web: fetch streaming), `getTaskWork`/`getTaskWorkSummary` da `/work`. Test con server finto, «nessuna chiamata fuori elenco».

### Task 3a.4 (chiusura)
Parità `apps/desktop/docs/integration-area3a.md`, prove a mano aggiunte, deploy-log se il server cambia.
