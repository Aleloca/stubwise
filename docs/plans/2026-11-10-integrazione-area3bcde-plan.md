# Integrazione area 3, fette 3b–3e — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Spec:** `docs/plans/2026-11-10-integrazione-area3-claude-design.md` (decisioni del maintainer del 10 nov 2026). Regole: `docs/invariants/{agent-sessions,pr-corrections,backlog-refine,permissions}.md` e i due divieti dell'operatore in `CLAUDE.md`. Branch `feat/integrazione-area3`. Test solo filtrati; golden (`apps/worker/scripts/golden/`) **solo** se si toccano prompt, runner o CLI — in quel caso fermarsi e chiedere all'orchestratrice.

## Review Focus

1. **Chi approva**: un'approvazione, un rifiuto, una pre-approvazione o una revoca da chi non ha `plans.approve` → 403 **e** stato invariato, da ogni porta (rotte, «Da decidere», riquadro).
2. **«Annulla il lavoro» su un job già concluso o in un altro stato**: 409, nessun effetto collaterale (PR intatte).
3. **Claude assegnato da chi non ha `runs.start`**: rifiutato; Claude non riceve mai notifiche né push.
4. **Standup**: nessuna attività di un progetto invisibile entra nell'aggregato.
5. **Refinement**: resta in sola lettura e il suo piano NON è approvato.

---

## 3b «Agire»

### 3b.1 (server)
- **«Annulla il lavoro»**: `POST /api/tasks/:id/cancel-run` (`runs.start` nel progetto, `ticketVisible`), con conferma lato client: chiude subito il job attivo (stati vivi o in pausa/`held`/`awaiting_*`), segna la sessione chiusa, non tocca PR né branch; 409 `nothing_to_cancel` se non c'è lavoro vivo. Rispetta «Job e correzione si chiudono INSIEME» (`pr-corrections.md`). Evento in storia del ticket e `ticket.activity` ai follower se pertinente.
- **«Da decidere» di Claude**: `GET /api/me/claude-decisions` → piani da approvare (solo a chi ha `plans.approve` nel progetto) e domande aperte (a chi può rispondere: richiedente o `plans.approve`), forma `ClaudeDecision` del prototipo, con `webHref`.
- Le altre azioni esistono già (run-ai, relaunch con istruzioni, resume, corrections, approve/reject/pre-approve/revoke, answer, messaggi e interrupt delle sessioni): verifica che le risposte d'errore siano quelle che il renderer deve mostrare e che `TaskWork.actions` resti coerente dopo ogni azione. api-client per tutte.
### 3b.2 (renderer)
Azioni della sezione Claude, del riquadro e della pagina /claude collegate alle rotte (ottimistico solo dove sicuro), casella e «Ferma» nelle sessioni dove `canWrite`/`canInterrupt`, «Annulla il lavoro» con conferma, piano e domande nelle sessioni e in «Da decidere» (sorgente Claude riaccesa), i permessi sempre dal server.

## 3c Refinement

### 3c.1 (server, se serve)
Le rotte esistono (`/api/backlog/:id/refine-session`, messaggi e stream come le altre sessioni): portarle anche sotto `/api/requests/:id/refine` se il renderer ne ha bisogno, e l'aggiornamento della richiesta dal `work_result` letto dalla sessione.
### 3c.2 (renderer)
Bottone «Rifinisci con Claude» riacceso, `RefineView` sulla sessione vera, proposte, chiusura → richiesta aggiornata.

## 3d Activity per persona

### 3d.1 (server)
Permesso `people.activity.view` nel registro d'istanza (gruppo, frasi; nessun preset tranne il full admin implicito; migrazione dei preset solo se serve). `GET /api/people/activity?date=YYYY-MM-DD&departmentId=` → `PersonDayActivity[]` del prototipo: per persona (Claude escluso) task chiuse, spostate, commenti, decisioni, richieste, commit (dai `commit_summaries`/daily report collegati all'autore) del giorno nel fuso Europe/Rome, solo dei progetti visibili a chi guarda. Più `linkCommitAuthor` e i report giornalieri esistenti se il prototipo li usa da lì.
### 3d.2 (renderer)
Scheda «By person» di Activity riaccesa sui dati veri.

## 3e Claude assegnabile

### 3e.1 (server)
Utente di sistema «Claude» per istanza (migrazione: `users.is_agent boolean`, riga unica, nessuna password, nessun accesso — login, PAT, sessioni rifiutati per costruzione — escluso da notifiche, push, inbox, conteggi delle persone dove non pertinente). Assegnare Claude a una task (PATCH, bulk, plan, create) richiede `runs.start` nel progetto e **avvia il run** come `run-ai` (stesse precondizioni e gate del piano: chi non ha `plans.approve` passa dal gate); togliere Claude non annulla da solo il lavoro (resta «Annulla il lavoro»). `/api/people` lo include con `isClaude: true` solo per chi ha `runs.start` in almeno un progetto visibile, o lo include sempre ma con il permesso per progetto: scegli e motiva. Planning: la riga Claude con il suo carico.
### 3e.2 (renderer)
`featureIntegrated("claude-assign")` acceso: assegnatari, Planning, carico, stato di Claude sulle carte.

## Chiusura di ogni fetta
Parità `apps/desktop/docs/integration-area3<x>.md`, prove a mano aggiunte a `integration-manual-tests.md`, voce del deploy-log quando il server cambia.
