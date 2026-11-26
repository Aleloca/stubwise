# Integrazione area 4 — Chat, fetta 3: @Claude nei canali — piano (10 nov 2026)

> Autore: stubwise-72 (server e worker), renderer a stubwise-94. Branch del
> server: `feat/area4-f3-server`, da `origin/feat/area4-f2-server`.
>
> **Specifica**: il prototipo.
> - `apps/desktop/src/renderer/data/chat/claude.ts` (chiamata, risposta, stop,
>   «Try again», domanda, proposte);
> - `data/chat/reads.ts` (`presentMessage`, `redactClaudeEvents`,
>   `chatProposalExpired`, `chatClaudeQuestionsOf`);
> - il design `docs/plans/2026-10-25-desktop-area4-chat-design.md` §«@Claude».
>
> **Decisioni già prese**:
> - D5 del design d'integrazione (`…-integrazione-area4-chat-design.md`): nel
>   canale solo la risposta e le schede, gli eventi dei tool solo a chi ha
>   chiamato;
> - dal prototipo:
>   - ogni «@Claude» è una chiamata NUOVA di chi la scrive, con i suoi
>     permessi e senza altri controlli;
>   - la risposta è marcata «Claude, chiamato da X»;
>   - tutto è proposta (classe forzata a B), niente «Annulla», conferma solo
>     chi ha chiamato;
>   - le proposte scadono dopo 20 messaggi del thread o 24 ore;
>   - il contesto è il thread, letto come lo legge chi chiama.
>
> **Base da riusare**: la chat con Claude, fette 1–5 (`apps/worker/src/claude-chat/*`,
> `apps/worker/src/chat-mcp/*`, `apps/server/src/claude-actions/*`, token del
> turno, ponte, `propose_action`, `claude_proposals`).

## Perimetro

1. **Chiamare.** Un messaggio di una persona che contiene «@Claude», in un
   canale che lei può scrivere, fa nascere SUBITO nel thread di quel messaggio
   una risposta vuota.
   - È di tipo `claude`, ha `called_by` = chi chiama ed è nello stato
     «working». Accade anche quando la chiamata è una radice del canale:
     risponde sempre nel thread.
   - Senza «@Claude» non succede niente.
   - Una modifica che aggiunge «@Claude» non chiama, come nel prototipo.
   - «@Claude» non è una persona: non dà card, e Claude non è membro di nulla.
2. **Rispondere.**
   - Il testo arriva dal vivo nel thread, per tutti i lettori.
   - La risposta finisce in «done», oppure in «waiting» se Claude ha fatto
     una domanda, oppure in «failed» col motivo (`forbidden`, `not_found`,
     `budget`, `other`).
   - Le righe d'azione (gli eventi dei tool, «cosa ha letto») le vede SOLO chi
     ha chiamato (D5).
3. **Proporre.**
   - Le modifiche sono sempre proposte di classe **B**, qualunque sia la classe
     calcolata. Niente esecuzione immediata, niente «Annulla» dopo la
     conferma. Le azioni della pagina (`pageAction`) qui non esistono.
   - La scheda la vedono tutti i lettori del thread. Gli argomenti delle azioni
     e i codici nati dalla conferma solo nella misura in cui li vedono (sotto).
   - Conferma e annulla solo chi ha chiamato, se è ancora membro del canale e
     il canale non è archiviato.
   - Le proposte scadono a lettura dopo 20 messaggi del thread arrivati dopo la
     risposta, o dopo 24 ore.
4. **Chiedere** (R-G4).
   - Claude può fare UNA domanda a scelta multipla a chi l'ha chiamato. La
     risposta resta «waiting».
   - La domanda compare nel thread e in «Da decidere» di chi ha chiamato.
   - Risponde solo lui, una volta sola (`already_answered`), dal thread o da
     «Da decidere»: è la stessa domanda.
   - Dopo la risposta la STESSA risposta di Claude riparte, senza poter
     chiedere di nuovo.
   - La domanda esce da «Da decidere» quando ha una risposta, quando la
     risposta di Claude è fermata o eliminata, o quando il canale è archiviato
     o non è più letto.
5. **Fermare, rifare, eliminare.**
   - «Stop»: solo chi ha chiamato, su una risposta che lavora o aspetta. Il
     testo arrivato resta e le righe in corso si chiudono «fermate».
   - «Try again»: solo su una «failed», una volta sola. Fa una risposta NUOVA in
     fondo al thread, con lo stesso contesto, se il messaggio che chiamava c'è
     ancora.
   - Eliminare una risposta di Claude: solo chi l'ha chiamata (D6). Se lavora,
     si ferma, e le sue proposte aperte decadono.
6. **«Da decidere»**: le domande di Claude accanto a quelle delle persone
   (`GET /api/chat/claude-questions`, `chatClaudeQuestionsOf` del prototipo).
7. **Fuori**:
   - gli eventi dei progetti nei canali e gli allegati restano alla fetta 4;
   - il difetto di `openHref` nella build app lo registra e lo corregge 94
     (renderer).

## Decisioni (prese dal maintainer, 10 nov 2026)

1. **DECISO (a) (M).** **«via Claude» nella Chat** (la voce del registro: `chat_messages.via_claude_action_id`
   c'è, ma nessuno lo scrive). Il catalogo del prototipo non ha nessuna azione
   che scriva un messaggio nella Chat. «Claude nella Chat» è la risposta
   `kind claude` «chiamato da X», non un messaggio di una persona scritto da
   Claude.
   - **(a, consigliata)** Si chiude la voce: nessuna azione del catalogo scrive
     in Chat, e la colonna resta inerte per un'azione futura (se mai ci sarà,
     sarà una decisione di prodotto).
   - (b) Si aggiunge al catalogo un'azione «scrivi nel canale» (Claude manda
     un messaggio a nome di chi chiama, «via Claude»). È un'azione nuova, non
     del prototipo.
2. **DECISO (a) (M).** **Quanto si può chiamare @Claude.** Chiunque scriva in un canale può
   chiamarlo, e ogni chiamata è un turno a pagamento.
   - **(a, consigliata)** Come le conversazioni con Claude: nessun tetto oltre
     al budget mensile dell'istanza. A budget finito la risposta nasce
     «failed» col motivo `budget`, senza turno.
   - (b) Un tetto per persona al giorno (es. 50 chiamate), con un 429 e il
     motivo nella risposta.

## Il modello (tecnico, mie scelte)

- **Una sessione dell'agente per chiamata**: kind nuovo `chat_mention`, a
  turni (`TURN_BASED_SESSION_KINDS`), PRIVATA di chi chiama come una `free`.
  - Gli eventi dei tool stanno lì, e li legge solo lui (D5), con le rotte di
    sempre `/api/agent-sessions/:id/…`.
  - Le proposte stanno in `claude_proposals` con quella sessione: l'esecutore,
    la classe, il segno «via Claude» sugli oggetti toccati e la regola del
    registro decisioni sono quelli di sempre.
- **Migrazione 0140** (il primo numero libero; lo ricontrollo prima di
  scriverla):
  - `chat_messages.agent_session_id` (FK `set null`), `claude_state`
    (`working|waiting|done|failed|stopped`, CHECK), `claude_error`,
    `claude_retried`, `call_message_id`;
  - `chat_claude_questions (reply_message_id, question_id, text, options,
    answer, answered_by, answered_at)`;
  - il valore `chat_mention` del kind delle sessioni, se è un enum di
    Postgres: in uno statement a sé.
- **Il contesto lo costruisce il SERVER alla chiamata**, perché solo lui sa
  cosa legge chi chiama:
  - il thread fino alla chiamata, senza gli eliminati;
  - le citazioni con le etichette che VEDE chi chiama (`citationViews`);
  - i nomi.
  Finisce nell'input d'apertura della sessione, come testo neutralizzato
  (`neutralizeLabels`). Il worker non rilegge il canale.
- **Il turno** è `runChatTurn` con una variante:
  - un prompt d'avvio della Chat (rispondi nel thread, breve; proponi, non
    dire mai fatto; una domanda sola, a chi chiama);
  - gli stessi tool di lettura e `propose_action`, col token del turno di chi
    chiama;
  - in più il tool `ask_question`, solo nei turni `chat_mention`;
  - il testo dell'assistente scritto sul messaggio di risposta, a intervalli
    (≈1 s) e alla fine, con `updated_at` e il NOTIFY del canale. Lo stream
    della Chat lo porta già a tutti.
- **`ask_question` lo gestisce il WORKER**, nel ponte, scrivendo nel DB:
  - la riga della domanda, l'evento della sessione e `claude_state =
    waiting`; poi il turno finisce;
  - nessuna rotta di scrittura nuova per il token del turno: resta GET-only più
    la sola rotta delle proposte (`docs/invariants/second-factor.md`);
  - il modello passa testo e opzioni (2–5), validati; una seconda domanda
    nella stessa risposta è rifiutata.
- **Le proposte in una `chat_mention`** (`apps/server/src/claude-actions/proposals.ts`):
  - la classe è forzata a **B**, anche quando il calcolo dice A; `pageAction`
    è `invalid`;
  - la scadenza conta i messaggi del thread dopo la risposta, non quelli
    della conversazione;
  - `confirm`/`cancel` ricontrollano anche che chi conferma sia membro e che il
    canale non sia archiviato;
  - `requestUndo` rifiuta un gruppo nato da una `chat_mention`.
- **La vista del messaggio `claude`** (`chatMessageSchema`, campi additivi):
  - `claude: { state, calledById, error, retried, proposals[], question }`;
  - per chi NON ha chiamato: gli argomenti delle azioni vuoti, e i codici nati
    da una conferma filtrati con le regole delle task e delle richieste
    (`linksOf`). È `redactClaudeEvents` del prototipo, ridotto a ciò che il
    server registra davvero;
  - il testo di Claude lo leggono tutti uguale: ne risponde chi chiama.
- **Il segnale del thread** («Claude sta rispondendo»): sulla radice,
  `claudeReplying`, derivato.
- **Rotte nuove** (`config.access {kind:"user"}`, decide il servizio):
  - `POST /api/chat/messages/:id/claude/stop`;
  - `POST /api/chat/messages/:id/claude/retry`;
  - `POST /api/chat/messages/:id/claude/answer` `{questionId, optionIndex|text}`;
  - `POST /api/chat/messages/:id/claude/proposals/:proposalId/confirm|cancel`
    (sopra le funzioni delle proposte, con l'adattatore del messaggio);
  - `GET /api/chat/claude-questions`.
- **Consumi**: l'operazione AI è quella della chat (`claude_chat`), col
  `UsageTag` del progetto del canale quando ce n'è uno.

## Task

- **F3.1 — DB e schemi**:
  - 0140, `schema.ts`, il kind `chat_mention` in `agentSessionKindSchema` e in
    `TURN_BASED_SESSION_KINDS`;
  - i campi `claude` del messaggio, con default;
  - `chatClaudeQuestionSchema`.
  - Test: load-isolated, api-client, la migrazione, il parse di un messaggio
    della fetta 2 senza `claude`.
- **F3.2 — Server, chiamata e vista**:
  - la chiamata in `postMessage`, nella stessa transazione: la risposta, la
    sessione, l'input con il contesto;
  - budget finito → «failed» `budget`;
  - la vista del messaggio `claude` con la regola di chi guarda;
  - stop, retry, eliminazione.
  - Test: negativo D5 (un altro membro non legge la sessione né gli eventi:
    404), «chiamato da», una modifica non chiama, un non membro non chiama,
    retry una volta sola.
- **F3.3 — Proposte in Chat**:
  - classe forzata B, scadenza del thread, conferma solo di chi chiama (membro,
    non archiviato), niente undo;
  - la scheda per gli altri lettori senza argomenti né codici invisibili.
  - Test, con mutazioni: una A calcolata resta B; un altro membro riceve 403
    `not_yours`; dopo 20 messaggi o 24 ore la proposta è `expired`; undo
    rifiutato.
- **F3.4 — Worker, turno e domanda**:
  - la variante del turno, il prompt d'avvio, il testo dal vivo sul messaggio;
  - `ask_question` nel ponte;
  - la ripresa dopo la risposta.
  - Test unitari del ponte e del turno (runner finto).
- **F3.5 — Golden** sul CLI pinnato 2.1.322, coi plugin di sempre:
  - `chat-mention-read`: legge il contesto del thread e risponde senza
    inventare;
  - `chat-mention-propose`: una modifica diventa proposta, mai «fatto»;
  - `chat-mention-ask`: un bivio vero → `ask_question`, poi la ripresa.
  - Ognuno 3 volte. Uno scenario rosso NON si aggiusta forzando il prompt: lo
    porto all'orchestratrice.
- **F3.6 — Chiusura**:
  - deploy-log (0140, ordine server → worker → caddy, rollback: un server
    vecchio non conosce `chat_mention` e lo legge `__unknown__`; le risposte
    `claude` restano messaggi);
  - invariante della Chat aggiornata, registro, parità server, righe di
    CLAUDE.md per l'orchestratrice.

## Global Constraints

- **Il token del turno è di chi chiama**: GET-only più la sola rotta delle
  proposte. Hash nel DB, scade col turno, revocato nel `finally`; mai in log,
  prompt o eventi. Nessuna scrittura parte dal token senza la regola della
  classe, e qui la classe è sempre B.
- **Il contesto viene da altre persone** (il thread): è testo non fidato, e
  per questo il prompt lo marca come dato e non come istruzione, e
  `neutralizeLabels` lo neutralizza. La difesa vera è la classe B: niente
  succede senza la conferma di chi ha chiamato.
- **Il registro decisioni non si scrive mai**: `decisions-never-ai.test.ts`
  si estende ai moduli nuovi.
- **I due divieti dell'operatore valgono anche qui**: `startRun` passa dal gate
  del piano, e nessuna azione mergia.
- **Chi vede e chi legge resta `chat/access.ts`**. Le rotte nuove ci passano;
  una risposta in un canale che chi guarda non legge risponde 404.
- **Verso i client solo cambi additivi**: il kind nuovo è dietro
  `readerSchema`.
- **Test**: solo filtrati; mutazioni sui test passati al primo colpo; Docker
  coordinato con 94.

## Review Focus

- D5: gli eventi dei tool, gli argomenti delle proposte e la domanda (testo e
  opzioni) di una risposta. Li vede solo chi ha chiamato? La domanda nel thread
  la vedono tutti come nel prototipo, ma risponde solo lui.
- Una chiamata da un non membro, in un archiviato, in un privato che chi
  chiama gestisce senza esserne membro: non deve nascere niente.
- Le corse: la risposta alla domanda data due volte insieme, uno stop durante
  la scrittura del testo, l'eliminazione durante il turno.
