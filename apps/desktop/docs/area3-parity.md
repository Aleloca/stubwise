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
| Filtro per progetto e per esito (le concluse) | `ConversationList.tsx` | `pages/claude/ClaudePage.test.tsx` («le concluse si filtrano per esito e per progetto…») |
| Stato vuoto («live» e «recenti»), elenco filtrato senza risultati | `ConversationList.tsx` | `pages/claude/ClaudePage.test.tsx` («senza conversazioni proprie…», «Nothing matches») |
| «Non disponibile su questa istanza» (rotta mancante) | non serve: dati locali | — |
| Sessione: testata con tipo, titolo, progetto, link alla task, stato o esito | `pages/claude/ClaudePage.tsx` (testata), `ObjectSide.tsx` (gli stati si leggono col progetto della sessione, insieme alla task; mentre arrivano un segnaposto, uno stato sconosciuto toglie la riga) | `pages/claude/ClaudePage.test.tsx` («una sessione di lavoro non ha “Make public”… a lato la task con “Open task”», «a lato lo stato della task: mentre gli stati arrivano aspetta, poi lo dice», «uno stato che il lato non sa nominare: la riga “Status” non c'è…») |
| Trascrizione dal vivo in stream: testo di Claude a pezzi, azioni con ingresso e risultato (troncato), citazioni | `pages/claude/conversation/*` (`EventList`, `AssistantMessage`, `ActionRows`, `citations`), `data/stream.ts` | `pages/claude/conversation/Conversation.test.tsx` («il testo di Claude arriva a pezzi…», «azioni consecutive…», «citazioni…», «200+ azioni…»), `data/stream.test.ts`, `pages/claude/conversation/flow.test.ts` |
| Segmenti (fasi) con esito: ok, fallito, scaduto, «Stopped by {nome}» | `conversation/PhaseDivider.tsx`, `flow.ts` | `Conversation.test.tsx` («“Stop” ferma la risposta: la fase dice chi l'ha fermata»), `flow.test.ts` («le fasi: durata…»), `data/seed.test.ts` (i quattro esiti) |
| Messaggi dell'utente con consegna: in attesa, consegnato, non consegnato col motivo | `conversation/parts.tsx`, `Composer.tsx` | `Conversation.test.tsx` («“Delivered” sparisce dopo 3 s…»), `data/conversation-composer.test.ts` |
| «Load earlier», pillola «New messages», «Reconnecting…» | `conversation/Conversation.tsx` | `Conversation.test.tsx` («riconnessione a metà messaggio», «200+ azioni…» per la finestra, «chi ha scorso in su non viene tirato giù: la pillola lo dice…»), `data/stream.test.ts` |
| In fondo all'apertura, anche dopo un cambio di persona (chi è in fondo ci resta a ogni disegno, e se il riquadro si accorcia) | `conversation/Conversation.tsx` | `Conversation.test.tsx` («dopo il cambio di persona la conversazione si apre in fondo…») |
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
| Attività AI: provider dell'esecuzione (account o chiave API, solo il nome) sotto lo stato e in ogni «Run started» della storia | `pages/task/ClaudeRunParts.tsx` (`ProviderLine`), `WorkStory.tsx`, `data/seed/runs.ts` | `ClaudeSection.test.tsx` («con quale account gira la sessione…»), `domain/claude/taskWork.test.ts` («la storia dice con quale account o chiave…») |
| Attività AI: riassunto del fallimento e «Show/Hide log» (le azioni della fase in cui la sessione è finita, con ingresso e risultato) | `ClaudeRunParts.tsx` (`FailureBlock`), `data/api.ts` (`failureSummary`) | `ClaudeSection.test.tsx` («fallita: il riassunto del fallimento e “Show log”…», «una sessione riuscita non ha né riassunto né log») |
| Uso AI: token e costo totali, per modello (ingresso, uscita, cache, costo); li vede chi vede la task, come `GET /api/tickets/:id/usage` (non `project.usage.view`, che sul server governa i consumi di progetto) | `ClaudeRunParts.tsx` (`UsageDisclosure`), `data/api.ts` (`usageOfTask`) | `ClaudeSection.test.tsx` («consumi AI: chiusi il totale, aperti una riga per modello», «i consumi li vede chi vede la task…», «senza consumi nessuna riga…») |
| Azioni sull'ultimo job: «Start» (`runs.start`), «Relaunch with instructions», in attesa di approvazione, in attesa di risposta | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («“Start” solo con runs.start», «fallita: “Relaunch with instructions”…», «…il rilancio parte dalle indicazioni») |
| «Resume correction» (`corrections.request`) | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («correzione ferma…», «senza corrections.request niente “Resume correction”») |
| «Request changes» su PR aperta, con nota; PR mergiata: nessuna azione | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («PR aperta: “Request changes”…», «…diventa una correzione», «PR mergiata…», «task chiusa con la PR mergiata…») |
| Assegna a Claude (nuovo: non avvia) | `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («“Assign to Claude” con tickets.edit…», «senza tickets.edit niente…») |
| Righe PR e ciclo di revisione: stato della PR, revisione, e sotto ogni PR aperta lo stato del ciclo come lo deriva il «server» (giro X di N, in attesa della review, approvata, modifiche chieste da chi e dove, fermo al tetto, correzione fallita, in coda) e «Blocked: this branch is protected» | `ClaudeRunParts.tsx` (`PrRows`), `data/seed/timeline.ts` (`PR_CYCLES`), `data/api.ts` (`cycles`) | `ClaudeSection.test.tsx` («PR aperta…», «PR su due repository: “2 repos”, e sotto ogni PR il suo ciclo…», «branch protetto e modifiche chieste da una persona…», «una PR sola: niente “N repos”…») |
| Repository / PR del ticket, badge «N repos» per una task su più repository | `ClaudeRunParts.tsx` (solo dove il progetto ha un repository; il repository viene dalla piattaforma) | `ClaudeSection.test.tsx` («progetto senza repository: niente PR…», «PR su due repository…»), `domain/claude/taskWork.test.ts` («una PR che conosce solo la piattaforma prende il repository…») |
| Domande passate («round, domanda, risposta, chi»), domanda aperta con «Waiting for an answer from …» | storia del lavoro; domanda aperta in `ClaudeSection.tsx` | `ClaudeSection.test.tsx` («la domanda si risponde qui…», «chi non può rispondere legge la domanda e chi può farlo») |

## Inbox → Home «Decide»

| Voce | Dove | Test |
|---|---|---|
| Domanda dell'agente (`job.awaiting_input`): scelta singola, «consigliata», «Other…», chi può rispondere (richiedente o `plans.approve`) | `pages/home/blocks/ClaudeDecisionItem.tsx`, `DecideBlock.tsx` | `DecideBlock.test.tsx` («Marco (richiedente) ha la domanda…», «Sara non vede né la domanda né il piano», «rispondere qui la chiude nella conversazione…», «risposta concorrente…», «“Undo”…») |
| Piano da approvare (`job.plan_review`): Approva, Rifiuta con indicazioni, «già deciso da» | `ClaudeDecisionItem.tsx` | `DecideBlock.test.tsx` («Laura (plans.approve) ha anche il piano…», «Laura approva il piano da qui…», «“Reject…” con le indicazioni…», «piano deciso da un altro…», «piano rifiutato e riscritto…») |
| Il punto «ti aspetta» sulla tessera del progetto quando Claude arriva a una domanda | tessera del rail (`data-signal="waiting"`), `data/api.ts` (`waitsOnViewer`) | `DecideBlock.test.tsx` («il punto “ti aspetta” sulla tessera…») |
| «Read the full plan» / apertura della conversazione dalla voce | `ClaudeDecisionItem.tsx` | `DecideBlock.test.tsx` («“Read the full plan” apre la sessione del piano, col piano intero») |
| Schede di Inbox, snooze, «Handled», tab Snoozed/Handled, altre tipologie (`job.failed`, `project.pulse`, Google…) | — | **area 1** (notifiche) / **area 6** (posta) |

## Backlog → sessione di refinement

| Voce | Dove | Test |
|---|---|---|
| Avvia, riprendi («Open refinement»), stato (Claude scrive / pronta) | `pages/requests/RequestDetail.tsx`, `RefineView.tsx` | `RefineView.test.tsx` («“Refine with Claude” apre la conversazione…», «una sessione viva si apre con “Open refinement”…»), `pages/requests/RequestsPage.test.tsx` |
| Conversazione di refinement e piano scritto da Claude («Not approved») | `RefineView.tsx`, `ObjectSide.tsx` | `RefineView.test.tsx` |
| Chiusura per richiesta trasformata o archiviata | `RefineView.tsx` | `RefineView.test.tsx` («archiviata altrove mentre è viva…») |
| Chi può scrivere (`backlog.edit`) | `RefineView.tsx` | `RefineView.test.tsx` («Sara (senza backlog.edit)…») |
| Suggerimenti AI su urgenza, taglia, rischio e nota («was X» / «was empty», il perché etichettato «Generated text»; Accept all / Dismiss con `backlog.edit`, che passano da `updateRequest`; le proposte si tolgono, non si scrivono dal client) | `pages/requests/RequestGuidance.tsx` (`SuggestionsSection`), `data/seed/requests.ts` (STW-R1, MKX-R2), `data/api-mutations.ts` | `pages/requests/RequestDetail.test.tsx` («dicono campo, valore proposto, “was” e perché; “Accept all” le scrive», «… “Dismiss” le toglie…», «senza backlog.edit si leggono…», «“Accept all” che non riesce…»), `data/mutations.test.ts` («le proposte dell'intake si tolgono e basta…») |
| Riga «prossimo passo» (da chiarire, pronta, task creata senza lavoro, piano in preparazione, piano da approvare, in corso, modifica pronta, fatto, serve attenzione) con «Go to <task>» | `domain/requestNextStep.ts` (puro, come `deriveNextStep` di `@stubwise/shared`), `RequestGuidance.tsx` (`NextStepLine`, una riga dei fatti della richiesta) | `domain/requestNextStep.test.ts`, `RequestDetail.test.tsx` («nuova: da chiarire», «pronta…», «trasformata con Claude al lavoro: “In progress” e “Go to STW-3”…», «Claude ha finito e la PR è aperta…», «archiviata: nessuna riga») |

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
| Filtro per reparto, ricerca di una persona (in più rispetto al web) | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («il filtro reparto sta nell'indirizzo…», «la ricerca per nome lascia solo chi corrisponde; senza nessuno “Clear filters”») |
| Permesso `people.activity.view` | `data/viewer.ts` | `PeopleActivity.test.tsx` («senza il permesso “By person” non c'è…»), `data/viewer.test.ts` |
| Avviso «N new commits not included» sul report del giorno (commit arrivati dopo che è stato scritto) e «Regenerate» (`settings.manage`) | `PeopleActivity.tsx` (`ReportCell`), `data/api.ts` (`newCommits` in `listDailyReports`), `data/seed/timeline.ts` (il report di oggi di STW, delle 10:00) | `PeopleActivity.test.tsx` («report scritto prima degli ultimi commit…»), `data/people-activity.test.ts` («i commit arrivati dopo il report si contano…») |
| Stati: nessun report, nessun progetto abilitato, nessuna attività, errore di caricamento | `PeopleActivity.tsx` | `PeopleActivity.test.tsx` («un giorno senza attività lo dice, e porta al giorno prima», «errore di caricamento: lo dice, e “Retry” ricarica») |

## Voci delle tabelle dell'area 2 che puntavano qui

Aggiornate in `area2-parity.md` al loro posto nuovo:

- «Piano, approvazione, domande dell'agente, avvio AI, storia del lavoro,
  attività AI, uso AI, correzioni, PR/cicli, adozione PR» → «Dettaglio
  ticket — parti AI» sopra (adozione PR: area 8, vedi «Riassegnate»).
- «Repository / PR / “N repos”» → righe PR della sezione Claude, con il
  ciclo e il badge «N repos».
- «Conversazione di refinement, suggerimenti AI, prossimo passo,
  design/piano» → «Backlog → sessione di refinement» sopra.
- «Activity “standup giornaliero”» → «Activity per sviluppatore» sopra.
- «Brief: “Rigenera”» → deciso: no (vedi «Riassegnate»).

## Chiusi dal Task 12

I buchi trovati dal Task 11 sono stati costruiti, ciascuno con il suo test
nelle tabelle sopra: uso AI della task; provider, riassunto del fallimento e
«Show/Hide log»; stato fine del ciclo della PR e «N repos»; suggerimenti AI
sui metadati della richiesta; riga «prossimo passo»; avviso «N new commits
not included» (ruling R-F3: sta nell'Activity per persona, sulla cella del
report); i test che mancavano (filtri di progetto ed esito delle sessioni,
pillola «New messages», ricerca per nome, vuoto ed errore di By person,
«Read the full plan» da Decide). Corretti anche i due difetti trovati dagli
scatti: la riga «Status» vuota nel lato delle sessioni (gli stati si
leggevano dopo la task) e la conversazione che dopo un cambio di persona non
restava in fondo.

Limite noto: una correzione ferma per budget non chiede ancora
`plans.approve` per riprendere (già registrato fra i minori aperti dei Task
7–9: il budget fermo non è modellato), quindi le righe «held» del ciclo non
sono nel seed.

## Buchi

Nessuno.

## Riassegnate

Voci dell'inventario che non sono dell'area 3, o su cui c'è una decisione:

1. **Adozione delle PR aperte da altri** («Let Stubwise fix it», «Stop
   correcting», stati non adottabili, `prs.adopt`) — «Corrections by
   Stubwise», inventario righe 235–238 → **area 8** (Rilasci e PR).
2. **Brief «Rigenera»** — voce di «Projects» → **deciso: no**. Il maintainer
   ha accettato l'assunzione della forma della Overview: il brief non si
   rigenera dalla Overview.
3. Inbox: le altre tipologie di scheda (pulse, brief, avvisi di sicurezza,
   monitor) → **aree 1, 6 e 9**.
