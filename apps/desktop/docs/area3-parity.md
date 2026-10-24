# Area 3 — parità con il web (24 ott 2026)

Una riga per voce dell'inventario (`web-inventory.md`, sezioni Inbox, Agents,
Ticket detail, Backlog item, Activity) coperta dall'area 3. Percorsi relativi
a `src/renderer/`. Stessa regola dell'area 2: ogni test citato esercita
davvero quella voce; dove una voce non ha un test lo si scrive («nessun test»),
senza citare un file; «area N» = voce assegnata a un'area successiva; ciò che
non ha un posto sta in «Buchi», non è stato costruito.

In sintesi: le sessioni degli agenti sono diventate **conversazioni** della
destinazione Claude (`#/claude`, `#/claude/<id>`); la sezione AI del ticket è
la sezione «Claude» del pannello della task; le domande e i piani in Inbox
sono voci di «Decide» in Home; il refinement è la vista `?refine=1` delle
richieste; l'Activity per sviluppatore è «By person» in All projects.

## Agents → destinazione Claude

| Voce dell'inventario | Dove vive ora | Test |
|---|---|---|
| Elenco: «Working now» e «Finished» (al posto di live/ultimi 14 giorni: anche Mine e Public) con tipo, titolo, progetto e codice, stato o esito, ora dell'ultimo evento, attività in parole; chi aspetta me in testa | `pages/claude/ClaudeColumn.tsx`, `ConversationList.tsx`, `marks.tsx` | `pages/claude/ClaudePage.test.tsx` («Working now: tipo, codice e titolo…», «elenchi per persona»), `data/claude-destination.test.ts` |
| Filtro per tipo | `ConversationList.tsx` | `pages/claude/ClaudePage.test.tsx` («filtro per tipo; senza risultati…») |
| Filtro per progetto e per esito (le concluse) | `ConversationList.tsx` | nessun test |
| Stato vuoto («live» e «recenti»), elenco filtrato senza risultati | `ConversationList.tsx` | `pages/claude/ClaudePage.test.tsx` («senza conversazioni proprie…», «Nothing matches») |
| «Non disponibile su questa istanza» (rotta mancante) | non serve: dati locali | — |
| Sessione: testata con tipo, titolo, progetto, link alla task, stato o esito | `pages/claude/ClaudePage.tsx` (testata), `ObjectSide.tsx` | `pages/claude/ClaudePage.test.tsx` («una sessione di lavoro non ha “Make public”… a lato la task con “Open task”») |
| Trascrizione dal vivo in stream: testo di Claude a pezzi, azioni con ingresso e risultato (troncato), citazioni | `pages/claude/conversation/*` (`EventList`, `AssistantMessage`, `ActionRows`, `citations`), `data/stream.ts` | `pages/claude/conversation/Conversation.test.tsx` («il testo di Claude arriva a pezzi…», «azioni consecutive…», «citazioni…», «200+ azioni…»), `data/stream.test.ts`, `pages/claude/conversation/flow.test.ts` |
| Segmenti (fasi) con esito: ok, fallito, scaduto, «Stopped by {nome}» | `conversation/PhaseDivider.tsx`, `flow.ts` | `Conversation.test.tsx` («“Stop” ferma la risposta: la fase dice chi l'ha fermata»), `flow.test.ts` («le fasi: durata…»), `data/seed.test.ts` (i quattro esiti) |
| Messaggi dell'utente con consegna: in attesa, consegnato, non consegnato col motivo | `conversation/parts.tsx`, `Composer.tsx` | `Conversation.test.tsx` («“Delivered” sparisce dopo 3 s…»), `data/conversation-composer.test.ts` |
| «Load earlier», pillola «New messages», «Reconnecting…» | `conversation/Conversation.tsx` | `Conversation.test.tsx` («riconnessione a metà messaggio», «200+ azioni…» per la finestra), `data/stream.test.ts`; la pillola «New messages»: nessun test |
| Casella: Invia, «Stop and send», Stop, Reinvia un messaggio non consegnato | `conversation/Composer.tsx` | `Conversation.test.tsx` («mentre Claude risponde: Stop…», «“Stop” rifiutato…», «“Stop and send” rifiutato…», «…permesso tolto nel frattempo»), `data/conversation-composer.test.ts` |
| Domanda dell'agente sul posto (a scelta, «consigliata», «Other…») | `conversation/QuestionCard.tsx` | `Conversation.test.tsx` («una domanda risposta si riduce a “Answered by …”»), `pages/home/blocks/DecideBlock.test.tsx` |
| Piano nella conversazione (in breve, piano intero, approva/rifiuta con indicazioni, «già deciso da») | `conversation/PlanCard.tsx` | `Conversation.test.tsx` («approvato il piano…», «piano deciso da un altro…», «i bottoni del piano seguono canDecidePlan») |
| Pannello laterale del refinement (urgenza, taglia, rischio, design, piano) | `pages/claude/ObjectSide.tsx`, `pages/requests/RefineView.tsx` | `pages/requests/RefineView.test.tsx` («la richiesta a lato cambia quando Claude scrive», «“See” porta il lato sulla sezione scritta…») |
| Chiudi il refinement, con conferma | `RefineView.tsx` | `RefineView.test.tsx` («“Close the session” chiede conferma…», «…non riuscito») |
| Messaggi di sola lettura («si può solo guardare», «solo un maintainer può scrivere», «in pausa») | `conversation/Conversation.tsx` (`ReadOnlyBand`) | `Conversation.test.tsx` («sola lettura: al posto della casella il motivo del “server”»), `RefineView.test.tsx` («Sara sull'indirizzo del refine…») |
| «Non trovata (o non visibile)» | `pages/claude/ClaudePage.tsx` | `ClaudePage.test.tsx` («il link diretto alla posta di Giulia, per Roberta, è “doesn't exist”») |
| Sessioni di posta, brief, report, docs, intake, PR review: sola lettura, a chi ne ha titolo | `data/seed/conversations/automatic.ts`, `ClaudePage.tsx` | `ClaudePage.test.tsx` («la sessione della posta solo al titolare…», «Giulia vede la sua sessione di posta fra le concluse») |
| Sessione per job `/agents/job/$jobId?ticketId=` | non serve: la sezione Claude della task apre la sessione per id; senza sessioni visibili dice perché | `pages/task/ClaudeSection.test.tsx` («sessioni che chi guarda non vede…», «“Start” avvia la sessione della task») |

Voci nuove dell'area, senza equivalente web (specifiche del design):
conversazione libera con markdown, codice, proposte confermabili
(`Conversation.test.tsx`, «proposte»), pubblica/privata e continuazione
(`ClaudePage.test.tsx`, «pubblica, privata, continuazione»), riga «il resto è
privato» (`Conversation.test.tsx`, «il seguito privato di una pubblica»),
palette «Ask Claude…» (`ClaudePage.test.tsx`), «Follow here»
(`ClaudeSection.test.tsx`).

## Dettaglio ticket — parti AI → sezione «Claude» del pannello

| Voce | Dove | Test |
|---|---|---|
| Piano di implementazione (markdown) con «In brief» e stato di approvazione («approvato da X» / «piano cambiato dopo l'approvazione») | `pages/task/ClaudeSection.tsx`, `conversation/PlanCard.tsx` | `ClaudeSection.test.tsx` («il piano si approva solo con plans.approve», «chi ha plans.approve approva il piano dalla sezione»), `Conversation.test.tsx` |
| Approva in anticipo / revoca (`plans.approve`) | menu «More actions for Claude» | `ClaudeSection.test.tsx` («l'approvazione in anticipo è nel menu solo con plans.approve», «…approva in anticipo dal menu») |
| Storia del lavoro (richiesta, piano, domanda e risposta, PR, correzioni, stop) | `pages/task/WorkStory.tsx`, `domain/claude/taskWork.ts` | `ClaudeSection.test.tsx` («la storia del lavoro è chiusa, e aperta va dalla più vecchia»), `domain/claude/taskWork.test.ts` |
| Attività AI: stato del lavoro, «Open session» / «Follow here», ultimo messaggio di Claude | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («Follow here: la sessione nel pannello…», «Claude che aspetta chi guarda»), `Conversation`/`ClaudePage` per la sessione |
| Azioni sull'ultimo job: «Start» (`runs.start`), «Relaunch with instructions», in attesa di approvazione, in attesa di risposta | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («“Start” solo con runs.start», «fallita: “Relaunch with instructions”…», «…il rilancio parte dalle indicazioni») |
| «Resume correction» (`corrections.request`) | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («correzione ferma…», «senza corrections.request niente “Resume correction”») |
| «Request changes» su PR aperta, con nota; PR mergiata: nessuna azione | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («PR aperta: “Request changes”…», «…diventa una correzione», «PR mergiata…», «task chiusa con la PR mergiata…») |
| Assegna a Claude (nuovo: non avvia) | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («“Assign to Claude” con tickets.edit…», «senza tickets.edit niente…») |
| Righe PR e ciclo di revisione (stato della PR, revisione) | `ClaudeSection.tsx` (righe PR) | `ClaudeSection.test.tsx` («PR aperta…»); lo stato fine del ciclo (round X di N, tetto, protetto, in coda): nessun test |
| Repository / PR del ticket | `ClaudeSection.tsx` (solo dove il progetto ha un repository) | `ClaudeSection.test.tsx` («progetto senza repository: niente PR…») |
| Domande passate («round, domanda, risposta, chi»), domanda aperta con «Waiting for an answer from …» | storia del lavoro; domanda aperta in `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («la domanda si risponde qui…», «chi non può rispondere legge la domanda e chi può farlo») |

## Inbox → Home «Decide»

| Voce | Dove | Test |
|---|---|---|
| Domanda dell'agente (`job.awaiting_input`): scelta singola, «consigliata», «Other…», chi può rispondere (richiedente o `plans.approve`) | `pages/home/blocks/ClaudeDecisionItem.tsx`, `DecideBlock.tsx` | `DecideBlock.test.tsx` («Marco (richiedente) ha la domanda…», «Sara non vede né la domanda né il piano», «rispondere qui la chiude nella conversazione…», «risposta concorrente…», «“Undo”…») |
| Piano da approvare (`job.plan_review`): Approva, Rifiuta con indicazioni, «già deciso da» | `ClaudeDecisionItem.tsx` | `DecideBlock.test.tsx` («Laura (plans.approve) ha anche il piano…», «Laura approva il piano da qui…», «“Reject…” con le indicazioni…», «piano deciso da un altro…», «piano rifiutato e riscritto…») |
| Il punto «ti aspetta» sulla tessera del progetto quando Claude arriva a una domanda | tessera del rail (`data-signal="waiting"`), `data/api.ts` (`waitsOnViewer`) | `DecideBlock.test.tsx` («il punto “ti aspetta” sulla tessera…») |
| «Read the full plan» / apertura della conversazione dalla voce | `ClaudeDecisionItem.tsx` | nessun test |
| Schede di Inbox, snooze, «Handled», tab Snoozed/Handled, altre tipologie (`job.failed`, `project.pulse`, Google…) | — | **area 1** (notifiche) / **area 6** (posta) |

## Backlog → sessione di refinement

| Voce | Dove | Test |
|---|---|---|
| Avvia, riprendi («Open refinement»), stato (Claude scrive / pronta) | `pages/requests/RequestDetail.tsx`, `RefineView.tsx` | `RefineView.test.tsx` («“Refine with Claude” apre la conversazione…», «una sessione viva si apre con “Open refinement”…»), `pages/requests/RequestsPage.test.tsx` |
| Conversazione di refinement e piano scritto da Claude («Not approved») | `RefineView.tsx`, `ObjectSide.tsx` | `RefineView.test.tsx` |
| Chiusura per richiesta trasformata o archiviata | `RefineView.tsx` | `RefineView.test.tsx` («archiviata altrove mentre è viva…») |
| Chi può scrivere (`backlog.edit`) | `RefineView.tsx` | `RefineView.test.tsx` («Sara (senza backlog.edit)…») |
| Suggerimenti AI su taglia/rischio/urgenza («was X», Accept all / Dismiss) | — | **buco** (vedi sotto) |
| Riga «prossimo passo» (chiarire, pronta, in esecuzione, PR pronta…) | — | **buco** (vedi sotto) |

## Activity per sviluppatore → All projects ▸ Activity ▸ «By person»

| Voce | Dove | Test |
|---|---|---|
| Selettore del giorno, precedente/successivo (`[` e `]`), «Today»; niente futuro | `pages/projects/PeopleActivity.tsx` | `pages/projects/PeopleActivity.test.tsx` («[ e ] cambiano giorno…», «un giorno dal link oltre oggi torna a oggi») |
| «By project» e «By person» con conteggi di commit, autori, progetti | `AllProjectsPage.tsx`, `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («dalla scheda Activity si passa a By person…»); «By project»: `AllProjectsPage.test.tsx` |
| Blocchi richiudibili; commit con descrizione AI (etichettata «Generated text») | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («aperta, una persona mostra i commit col messaggio e sotto il testo generato etichettato») |
| Solo i progetti che chi guarda vede | `data/api.ts` | `PeopleActivity.test.tsx` («solo i progetti che chi guarda vede, anche nei conteggi»), `data/people-activity.test.ts` |
| Stato del report: pronto, in generazione, fallito, mancante | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («“Generate report” con settings.manage…»), `data/people-activity.test.ts` |
| «Generate report» / rigenera (`settings.manage`) | `PeopleActivity.tsx` | `PeopleActivity.test.tsx`, `data/people-activity.test.ts` |
| «Link team member» per un'identità git non risolta («Unknown author»), `users.manage` | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («“Link a person” con users.manage…»), `data/people-activity.test.ts` |
| Filtro per reparto, ricerca di una persona (in più rispetto al web) | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («il filtro reparto sta nell'indirizzo…»); la ricerca per nome: nessun test |
| Permesso `people.activity.view` | `data/viewer.ts` | `PeopleActivity.test.tsx` («senza il permesso “By person” non c'è…»), `data/viewer.test.ts` |
| Avviso «N nuovi commit non inclusi» (report vecchio) | — | **buco** (vedi sotto) |
| Stati: nessun report, nessun progetto abilitato, nessuna attività, errore di caricamento | `PeopleActivity.tsx` | errore: nessun test; «nessuna attività» («No activity»): nessun test |

## Voci delle tabelle dell'area 2 che puntavano qui

Aggiornate in `area2-parity.md` al loro posto nuovo:

- «Piano, approvazione, domande dell'agente, avvio AI, storia del lavoro,
  attività AI, uso AI, correzioni, PR/cicli, adozione PR» → «Dettaglio
  ticket — parti AI» sopra (uso AI e adozione PR: buchi).
- «Repository / PR / “N repos”» → righe PR della sezione Claude (il badge
  «N repos»: buco).
- «Conversazione di refinement, suggerimenti AI, prossimo passo,
  design/piano» → «Backlog → sessione di refinement» (suggerimenti AI e
  prossimo passo: buchi).
- «Activity “standup giornaliero”» → «Activity per sviluppatore» sopra.
- «Brief: “Rigenera”» → buco.

## Buchi

Voci dell'inventario senza un posto nel prototipo. Non costruite, come da
regola; vanno nel backlog del prototipo o in una decisione di prodotto.

1. **Uso AI** del ticket (token e costo totali, per modello) — «Ticket detail →
   AI usage panel», inventario riga 243. Dato che il prototipo non modella.
2. **Adozione delle PR aperte da altri** («Let Stubwise fix it», «Stop
   correcting», stati non adottabili) — «Corrections by Stubwise»
   (`prs.adopt`), inventario righe 235–238.
3. **Provider dell'esecuzione** (account o chiave API, riassunto del
   fallimento, «Show/hide log») nella riga di attività AI — «AI activity»,
   inventario riga 223. Resta «Open session», che porta al racconto in
   conversazione.
4. **Stato fine del ciclo della PR** (round X di N, tetto, protetta, in coda,
   «blocked on a protected branch») e badge «N repos» — «Repository / PR
   rows», inventario righe 239–242. Il prototipo mostra PR e revisione, non il
   ciclo.
5. **Suggerimenti AI su metadati della richiesta** («was X», Accept all /
   Dismiss) — «Backlog item → AI suggestions», inventario riga 289. In
   refinement è Claude a scrivere i metadati, e la richiesta a lato cambia.
6. **Riga «prossimo passo»** della richiesta (chiarire, pronta,
   in esecuzione, PR pronta, serve attenzione) — inventario riga 283.
7. **Brief «Rigenera»** — voce di «Projects» già segnata dall'area 2.
8. **Avviso «N nuovi commit non inclusi»** sul report del giorno — «Activity →
   Stale warning», inventario riga 513.
9. **Filtro per progetto e per esito** nell'elenco delle sessioni: costruiti,
   ma senza test (vedi la tabella Agents).
10. Inbox: le altre tipologie di scheda (pulse, brief, avvisi di sicurezza,
    monitor) non sono area 3: **aree 1, 6 e 9**.
