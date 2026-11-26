# Chat con Claude, fette 1 (server) e 2 (renderer) — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Spec:** `docs/plans/2026-11-10-integrazione-claude-chat-design.md`. Registro: `docs/plans/integrazione-registro-rimandi.md` (sezione «Chat con Claude»). Invarianti: `docs/invariants/{agent-sessions,backlog-refine,providers}.md`, «Il registro decisioni non è MAI scritto dall'AI», «Ogni run AI dichiara un UsageTag» (`CLAUDE.md`). Branch: `feat/integrazione-claude-chat` (parte da `feat/integrazione-area3`).

## Global Constraints

- In queste due fette **nessuna azione**: Claude legge e risponde, non propone né esegue (le proposte sono la fetta 3).
- Il runner nuovo tocca prompt e CLI: **golden obbligatori** sul CLI pinnato (2.1.322) prima del merge.
- Conversazioni **private** (le pubbliche sono una fetta a sé, decisione del maintainer).
- Fuori portata: il modello risponde con i dati che può leggere per conto di chi scrive; a una richiesta di fare qualcosa dice che non può ancora e dove si fa a mano.

## Review Focus

1. **Lettura di un dato che chi scrive non vede**: i tool di lettura passano dal server con l'identità della persona → 404/vuoto, mai il dato.
2. **Budget mensile finito**: la casella si spegne, nessun turno parte.
3. **Turno lungo o CLI che muore**: la sessione resta coerente, «Ferma» funziona.
4. **Conversazione di un altro aperta da link**: 404.

### F1.1 (DB + server): conversazioni `free`
`agent_sessions` col kind nuovo `free` (ADD VALUE a sé se è un enum), tabella `claude_conversations(session_id pk/fk, owner_id, title, archived_at, context_ref jsonb null, created_at, updated_at)`. Rotte: `POST /api/claude/conversations` (crea, con contesto facoltativo), `GET /api/claude/conversations?scope=mine&archived=` (solo dell'autore), `GET /:id` (dettaglio = sessione + titolo/contesto), `PATCH /:id` (titolo, archivia, contesto), `DELETE /:id` (solo autore). I messaggi e lo stream sono quelli delle sessioni (`/api/agent-sessions/:id/messages|stream`) con le regole a turni (`TURN_BASED_SESSION_KINDS`); chi scrive è solo l'autore. Budget: la creazione e ogni messaggio controllano il budget mensile (409 `budget_exhausted`).

### F1.2 (worker): runner conversazionale a turni
Scheduler a turni come il refinement. Server MCP `stubwise_chat` **senza DB né credenziali** (ponte su loopback verso il worker, come `stubwise_refine`) con tool di **sola lettura** che il worker esegue chiamando il server con l'identità dell'autore (token di sessione a breve vita o servizio interno con `actorId` verificato — scegli e motiva): cerca task, leggi task, elenca progetti, leggi richiesta, cerca docs del progetto, leggi Overview/brief. `--setting-sources ""`, `--strict-mcp-config`, allowedTools chiuso, niente tool di file/bash. Prompt di sistema con il contratto: privato, legge per conto di chi scrive, non esegue niente, fuori portata = «non posso ancora, si fa da …». `UsageTag` `claude.chat`. Titolo dalla prima domanda (template, non AI). Golden nuovi: `chat-read` (risponde usando un tool di lettura), `chat-no-act` (alla richiesta di creare una task non fa niente e dice dove si fa), `chat-no-leak` (un progetto non visibile non entra nella risposta).

### F2.1 (renderer): la chat vera
`integration.ts`: `claude-chat` acceso (solo «Mine», niente «Public»). `real/claudeChat.ts`: `createConversation`, `listConversations({scope:"mine"})`, `getConversation`, `sendMessage`, `stop`, `stopAndSend`, `renameConversation`, `archiveConversation`, `deleteConversation`, `setConversationContext`, `describeContext`, `resolveCitations`/`resolveCodes` sulle letture vere, `searchMentions` (task, progetti, persone), `listCommands` (comandi Stubwise; skill del progetto se il server le espone). Destinazione Claude con «New», N, ⌘J/⌘K «Ask Claude», chip del contesto. Proposte e azioni restano spente (fetta 3). Test con server finto, «nessuna chiamata fuori elenco».

### Chiusura
Parità `apps/desktop/docs/integration-claude-chat.md`, registro aggiornato, deploy-log (migrazioni, worker col runner nuovo senza lavoro in corso), prove a mano.
