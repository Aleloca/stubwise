# Integrazione area 10, F2 — S1, un'automazione dal riquadro: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F2 — S1»
> (D-2 = a). Specifica: il prototipo, `data/claude/catalogMore.ts` (le tre
> voci delle bozze), `data/claude/trial.ts` (la prova), `QuestionCard`.
> Invarianti: `docs/invariants/automations.md` («Claude scrive solo
> BOZZE»), `claude-actions.md` («Gli eventi strutturati li scrive il
> server»), `chat.md` (`ask_question` di @Claude).
> Branch: `feat/area10-f2` da `feat/integrazione-area10`, dopo F1. Lato
> server e worker; la scheda di scelta, la riga della prova e l'apertura del
> costruttore sono di 94.

## Prima del codice

- **Nessuna [DECIDE]**: quello che si vede è già deciso (D-2 = a e il
  prototipo).
- **Migrazione 0197** (primo numero libero dopo la 0196), un file solo:
  1. il CHECK `agent_session_events_type_chk` riscritto con `question`;
  2. la tabella `claude_conversation_questions`;
  3. `automation_versions.via_claude_action_id uuid null`, con DEFAULT
     `nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid`.
     È la stessa forma della 0195, che lo ha già fatto per `change_log`, e
     la va riletta prima di scriverla.
- **Fatti del codice che contano**:
  - le rotte delle automazioni hanno `access: { kind: "user" }`, e il
    permesso (`automations.manage` nel progetto) lo controlla il servizio
    (`apps/server/src/automations/writes.ts`). Le voci del catalogo hanno lo
    stesso `access: { kind: "user" }`, e il rifiuto viene dal servizio;
  - i servizi LANCIANO (`badInput`, `invalid`, `forbidden`, `notFound`) e
    non restituiscono `{ ok }`. Serve un adattatore in UN posto, che porti
    l'errore a `CatalogRefusal` (`invalid` / `conflict` / `forbidden` /
    `not_found`). `stale` diventa `conflict`;
  - `createAutomation` apre la sua transazione (`db.transaction`). Chiamata
    col `tx` del catalogo diventa un savepoint, sulla stessa connessione,
    quindi la GUC `stubwise.via_claude_action_id` resta visibile al DEFAULT.
    Un test lo fissa;
  - `createAutomation` NON valida il flusso, perché una bozza può avere
    errori. La voce lo valida dopo, con `configErrorsOf` (lo stesso di
    `POST …/check`), e rifiuta `invalid` con gli errori: nella prova a secco
    la transazione si annulla e la scheda non nasce;
  - `deleteDraft` con una sola versione cancella l'automazione intera
    (`writes.ts:363`): è l'inverso di `createAutomation`;
  - `saveDraft` salta il controllo di `expectedRev` se l'ultima bozza è di
    chi salva (`last.savedBy === viewer.id`). Per «Annulla» non basta,
    perché chi ha salvato dopo può essere la stessa persona da una pagina.
    `changed_after` guarda `rev`, non chi;
  - `ask_question` oggi: il server MCP lo espone solo con `CHAT_ASK_QUESTION=1`
    (`chat-mcp/server.ts:98`), il ponte solo con `turn.ask`
    (`bridge.ts:545`), e lo scrive il WORKER (`askChatQuestion`,
    `claude-chat/mention.ts`), perché il token del turno è GET-only;
  - un messaggio della persona in una conversazione passa da
    `sendAgentMessage` (`POST /api/agent-sessions/:id/messages`, 202);
  - gli eventi della conversazione li scrive `sessionEvent`
    (`claude-actions/proposals.ts:76`), col NOTIFY dello stream.

## Regole di lavoro (le solite)

Come F1. In più, ogni task che tocca il catalogo lancia
`claude-actions-effects.test.ts`, `claude-actions-never.test.ts`,
`claude-actions-class.test.ts` e `claude-actions.test.ts`. `test-claude.ts`
(il modello) non deve diventare raggiungibile dal catalogo.

## Task 1 — la migrazione 0197

**File**: `packages/db/drizzle/0197_area10_questions.sql`, `meta/_journal.json`
(con il `when` crescente), `schema.ts`; test `migration-0197.test.ts`.

1. **RED**:
   - un evento `question` si inserisce; un tipo inventato è ancora rifiutato;
   - una domanda per `turn_id`: la seconda è rifiutata dall'indice unico;
   - cancellare la sessione cancella le domande;
   - un INSERT in `automation_versions` con la GUC impostata prende il suo
     valore, senza la GUC resta null.
2. **GREEN**: la migrazione, lo schema Drizzle (`claudeConversationQuestions`:
   `id`, `sessionId`, `turnId`, `text`, `options` jsonb, `answeredAt`,
   `answerIndex`, `answerText`, `answeredBy`, `createdAt`) e
   `automationVersions.viaClaudeActionId`.
3. **Mutazione**: togliere `question` dal CHECK, e il primo test diventa
   rosso.
4. **Giro**: `migration-0197.test.ts`, `migration-0195.test.ts`.

## Task 2 — le tre voci delle bozze

**File**: `packages/shared/src/schemas/claude-actions.ts` (fn, argomenti,
classe dichiarata), un modulo nuovo `apps/server/src/claude-actions/catalog-automations.ts`
(unito a `SERVER_CATALOG`), `catalog.ts` (`ActionObject.kind` più
`automation`), `undo.ts` (`changed_after` per `automation`), worker
`chat-mcp/server.ts` (`PROPOSABLE_FNS`). Test nuovo
`claude-actions-automations.test.ts`, più `-never`, `-class`, `-effects`.

1. **RED** (`claude-actions-automations.test.ts`, Postgres vero):
   - `createAutomation` di chi ha `automations.manage` nel progetto: A, la
     bozza nasce `draft`, la versione 1 porta `via_claude_action_id`, e
     l'inverso è `deleteAutomationDraft` sul suo codice. «Annulla» la
     cancella tutta;
   - `projectId` assente o `null` → `invalid` (solo bozze di progetto);
   - senza il permesso → `forbidden`; un progetto invisibile → `not_found`,
     controllato PRIMA del flusso: un flusso sbagliato su un progetto
     invisibile dà `not_found`, non gli errori;
   - un flusso con errori di configurazione → `invalid` con gli errori, e
     nessuna riga resta (la prova a secco);
   - `saveAutomationDraft` su una bozza: A, e l'inverso rimette il flusso di
     prima, con nome e descrizione se cambiati. Su un'accesa senza bozza
     l'inverso è `deleteAutomationDraft`;
   - `expectedRev` vecchio → `conflict` (`stale`);
   - `changed_after`: se qualcuno salva la bozza dopo Claude (rev più alta),
     «Annulla» non c'è più, anche se è la stessa persona;
   - `deleteAutomationDraft`: B, nessun inverso.
2. **RED** (`claude-actions-never.test.ts`): `publishAutomation`,
   `activateAutomation`, `pauseAutomation`, `duplicateAutomation`,
   `runAutomation`, `approveRun`, `rejectRun` e `controlRun` sono
   nell'elenco dei nomi che il catalogo non deve mai nominare.
3. **GREEN**:
   - gli argomenti, `.strict()`:
     - `createAutomation`: `{ projectId: uuid, name, description?, flow }`;
     - `saveAutomationDraft`: `{ code, flow, expectedRev, name?, description? }`;
     - `deleteAutomationDraft`: `{ code, expectedRev }`;
   - le classi dichiarate: A, A, B;
   - l'adattatore degli errori;
   - `ActionObject { kind: "automation", id, code, stamp: String(rev) }`;
   - in `undo.ts`, un ramo che rilegge l'ultima versione e confronta `rev`.
     Lo `stamp` qui è la revisione, non un istante.
4. **Mutazioni**:
   - togliere la validazione con `configErrorsOf`: il test del flusso
     diventa rosso;
   - invertire l'ordine «progetto, poi flusso»: il test del `not_found`
     diventa rosso;
   - confrontare `savedBy` invece di `rev` in `changed_after`: il test
     «stessa persona» diventa rosso.
5. **Giro**: i test del catalogo elencati sopra, `claude-actions-change-log.test.ts`,
   `turn.test.ts`, `prompts.test.ts`. Typecheck.

## Task 3 — le domande a scelta nella conversazione libera

**File**: shared `agent-session.ts` (`question` nello `z.enum`),
`claude-conversation.ts` (lo schema della domanda nella vista);
worker `bridge.ts`, `turn.ts`, `chat-mcp/server.ts`, un modulo nuovo
`claude-chat/conversation-question.ts`; server, la rotta della risposta in
`routes/claude-conversations.ts` e il servizio in
`services/claude-conversation-questions.ts`. Test: `bridge.test.ts`,
`turn.test.ts`, `claude-conversation-questions.test.ts` (nuovo), il test
del parse in shared.

1. **RED, worker**:
   - nel turno di una conversazione libera, `ask_question` c'è (il turno
     passa `ask: true`);
   - nel turno di @Claude resta il gestore di oggi;
   - il gestore della libera scrive la riga e l'evento `question` con
     `data: { questionId }`. La risposta per il modello dice di chiudere il
     turno;
   - una seconda domanda nello stesso turno → «you already asked»;
   - testo e opzioni si validano come `askChatQuestion` (da 2 a 5 opzioni,
     tetti), e le regole stanno in UNA funzione condivisa, non copiata.
2. **RED, server**:
   - `POST /api/claude/conversations/:id/questions/:questionId/answer`,
     corpo `{ index }` oppure `{ text }` (fino a 500 caratteri):
     - l'autore riceve 202, la domanda è segnata, e un `input` «<label>»
       (o il testo) entra con `sendAgentMessage`;
     - chi legge una pubblica, ma non ne è l'autore, riceve 403;
     - la seconda risposta dà 409 `answered`;
     - un `index` fuori dalle opzioni dà 422;
     - una conversazione archiviata dà 409 `conversation_archived`, come
       `sendAgentMessage`;
   - la vista della conversazione dà ogni domanda (`questions[]`: id, testo,
     opzioni, risposta), additiva con `.default([])`, con il test che parsa
     una risposta senza il campo;
   - shared: una pagina di eventi con `type: "question"` letta da un
     `readerSchema` vecchio dà `UNKNOWN`, non un errore.
3. **GREEN**: segna la domanda e manda il messaggio nella STESSA transazione:
   se `sendAgentMessage` rifiuta, la domanda non resta segnata.
4. **Mutazioni**:
   - togliere il controllo dell'autore: il test 403 diventa rosso;
   - segnare la domanda fuori dalla transazione: il test «rifiutata, non
     segnata» diventa rosso.
5. **Giro**: `bridge.test.ts`, `turn.test.ts`, `prompts.test.ts`,
   `mention.test.ts` (worker); `claude-conversation-questions.test.ts`,
   `claude-conversations.test.ts`, `agent-sessions.messages.test.ts`,
   `chat-tool-token.test.ts` (server); `load-isolated.test.ts` (shared).

## Task 4 — il prompt e il golden S1

**File**: `apps/worker/src/claude-chat/prompts.ts`, `golden/run.ts`.

1. Il contratto della libera dice:
   - le automazioni da Claude sono SEMPRE bozze spente, che la persona
     accende dal costruttore;
   - prima di proporne una, se manca un dato (quale reparto, quale
     urgenza), una domanda con `ask_question`, e una sola;
   - mai dire «l'ho accesa».
2. Il test in `prompts.test.ts` controlla le tre frasi per chiave, non il
   testo intero.
3. Il golden `chat-s1-automation`, nella fixture: un progetto AUD con due
   reparti e la pagina Support come contesto. «Avvisa il reparto quando
   arriva una richiesta urgente dal supporto». Passa se:
   - il turno 1 chiama `ask_question` col reparto;
   - dopo la risposta, il turno 2 propone `createAutomation`, con un
     inizio `request_created`, un filtro su `richiesta.urgenza` e
     `richiesta.dal_supporto`, e un passo `notify` al reparto;
   - nessun `publishAutomation` nominato.

   Lo scenario si lancia 3 volte.
4. **Giro**: `prompts.test.ts`, `turn.test.ts`. Il golden si lancia a mano,
   e l'esito va nel report.

## Task 5 — documenti e chiusura

- `deploy-log.md`, voce «Integrazione area 10»:
  - la migrazione 0197, server prima del worker;
  - **rollback**: un CHECK più stretto non scende finché esistono eventi
    `question`. La voce dà la query che li conta e quella che li toglie, e
    dice che toglierli fa sparire le domande dalle conversazioni.
- `apps/desktop/docs/integration-claude-chat.md`: le tre voci, la domanda,
  la prova nel renderer (per 94).
- Il registro dei rimandi: chiusa «Claude non fa domande nella chat libera».

## Per 94 (renderer)

- La scheda di scelta (`QuestionCard`) da `questions[]` e dall'evento
  `question`. La risposta va su `POST …/answer`.
- La riga della prova (`TrialRow`): dopo un `actions_executed` con
  `createAutomation`, il renderer legge `GET /api/automations/:code/examples?version=draft`
  e fa girare il motore condiviso. «Wouldn't start» se il filtro
  dell'inizio esclude l'esempio. Niente si scrive.
- Il costruttore si apre da sé dopo la prova, con «Back to <pagina>».

## Review Focus

- Nessuna strada da Claude a «accesa» o «pubblicata»: il test del «mai»
  copre i nomi delle funzioni E delle rotte.
- La domanda e il messaggio della risposta sono atomici.
- `changed_after` delle automazioni guarda la revisione, non chi.
- Il DEFAULT di `via_claude_action_id` regge il savepoint di
  `createAutomation`.
