# Integrazione area 3 — Claude come collega — design

Data: 10 nov 2026. Segue l'integrazione dell'area 2
(`docs/plans/2026-11-09-integrazione-area2-*`), di cui valgono architettura,
tre build, `@backend/*`, «in arrivo», login e regole di lavoro. Specifica: il
prototipo — `docs/plans/2026-10-24-desktop-area3-claude-design.md`,
`apps/desktop/docs/area3-parity.md`, `apps/desktop/.impeccable/shape/{task-claude,claude-*,refine,people-activity}.md`,
e il codice in `apps/desktop/src/renderer/{pages/claude,pages/task/ClaudeSection*,layout/claudePanel,pages/requests/Refine*,pages/projects/PeopleActivity*,data/claude}`.
Regole del server che restano vere: `docs/invariants/{agent-sessions,pr-corrections,backlog-refine}.md`
e i due divieti dell'operatore in `CLAUDE.md`.

## Cosa entra (in fette)

- **3a «Guardare»**: la pagina Claude con le **sessioni di lavoro** vere (dal
  vivo, recenti, mie, per progetto e task), il **riquadro di Claude**, la
  **sezione Claude del dettaglio** completa in lettura (run, PR con ciclo,
  storia del lavoro, stato), lo **streaming** dal vivo su web e desktop.
- **3b «Agire»**: avvio, rilancio con indicazioni, riprendi la correzione,
  «Chiedi modifiche»; piano (approva, rifiuta con indicazioni, pre-approva,
  revoca); domande (`ask_user`); scrivere nella sessione, «Ferma», **«Annulla il
  lavoro»**; le voci di Claude in **«Da decidere»**.
- **3c Refinement** delle richieste: avvio e chiusura, la sessione, le proposte.
- **3d Activity per persona** (standup).
- **3e Claude come collega assegnabile**: «Assegna a Claude», Claude fra gli
  assegnatari, nel Planning e nel carico.

## Non entra

- La **chat libera con Claude** (conversazioni `free`, proposte, visibilità
  pubblica/privata delle chat) *(maintainer, 10 nov 2026)*: resta «in arrivo»
  e diventa una fase a sé subito dopo l'area 3, insieme alle azioni di Claude
  dell'area 10 (serve un agente conversazionale nuovo sul server).
- Adozione delle PR e rilascio (area 8).

## Decisioni del maintainer (10 nov 2026)

- **Prima il lavoro, chat dopo** (sopra).
- **Claude utente assegnabile**: un utente di sistema «Claude» per istanza,
  senza password né accesso, che non riceve notifiche né push. Assegnargli una
  task — con il permesso di avviare il lavoro (`runs.start`) nel progetto —
  avvia il run; Claude compare fra gli assegnatari, nel Planning e nel carico
  come nel prototipo. Chi non ha `runs.start` non vede Claude fra gli
  assegnatari proposti.
- **«Annulla il lavoro»** esplicito, oltre a «Ferma» (pausa): chiude subito il
  job, con conferma, per chi può avviare il lavoro su quella task; non tocca
  nessuna PR.
- **Standup per persona aggregato sul server**: una rotta per giorno (e
  reparto) che raccoglie per persona le attività già registrate, solo dei
  progetti che chi guarda vede, con il permesso `people.activity.view` nel
  registro vero (nessun preset lo riceve in automatico se non il full admin;
  si assegna dai ruoli).

## Scelte dell'orchestratrice

- **Le regole le decide il server**: visibilità delle sessioni, chi scrive o
  ferma (`agent_sessions.intervene`, `backlog.edit` nel refinement), chi
  risponde (richiedente o `plans.approve`), chi approva (`plans.approve`), le
  azioni possibili su una task (`TaskWork.actions` calcolate dal server in
  `/api/tasks/:id/work`). Il prototipo le deduceva; nell'app vera si leggono.
- **Pre-approvazione** come il server: vale sul digest del piano salvato;
  il prototipo la permetteva mentre il piano si scriveva — si adatta l'app.
- **Eventi**: un adattatore puro (in `@stubwise/shared`) dagli eventi del server
  ai `ConversationEvent` del prototipo; i `partial` aggiornano l'evento
  `assistant`; domande e piano vengono da `detail.questions` e dal piano del
  ticket.
- **Streaming dal desktop**: canale IPC dedicato con `MessageChannelMain`
  (allowlist stretta `/api/agent-sessions/:uuid/stream?after=n`, Bearer nel
  main, tetto di stream per finestra, timeout dei ping, ripresa governata dal
  renderer con `?after=`); sul web `fetch` streaming col cookie. Parse dei
  frame SSE, merge degli eventi per id e backoff in un modulo puro condiviso,
  poi usato anche da web vecchio e mobile quando li si tocca.
- **Moduli puri in `@stubwise/shared`**: `taskWork` (stato, storia, cicli PR),
  `prState`, selettori del log eventi (ultima domanda, piano in attesa, fase),
  SSE/merge/backoff, adattatore eventi. Non vanno in shared i permessi delle
  conversazioni (li manda il server) né il motore di intenti del prototipo.
- **«Da decidere»**: le voci di Claude (piani da approvare, domande) lette dal
  server in una rotta dedicata, con i permessi di chi guarda.

## Verifica

Come l'area 2: test del server con i casi negativi (403 **e** stato invariato,
404 per l'invisibile), golden quando si toccano prompt, runner o CLI
(`CLAUDE.md`), test dell'implementazione vera, prototipo invariato,
`check-no-seed`, giro completo, due review per fetta, parità
`apps/desktop/docs/integration-area3-<fetta>.md`, e le prove a mano aggiunte a
`apps/desktop/docs/integration-manual-tests.md`.
