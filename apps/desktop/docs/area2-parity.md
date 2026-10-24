# Area 2 — parità con il web (23 ott 2026, aggiornato il 24 ott)

Una riga per voce dell'inventario (`web-inventory.md`) coperta dall'area 2.
Percorsi relativi a `src/renderer/`. «area N» = voce che il design assegna a
un'area successiva (spec «Non obiettivi» / «Dettaglio della task»), non un
buco. Ogni test citato esercita davvero quella voce; dove una voce non ha un
test lo si scrive («nessun test»), senza citare un file. I buchi trovati dal
Task 15 sono chiusi dal Task 16 (in fondo, il riepilogo).

## Tickets → Tasks

| Voce dell'inventario | Dove vive ora | Test |
|---|---|---|
| Elenco: riga con codice, titolo, stato, taglia, scadenza, segno «ferma» | `pages/tasks/TaskList.tsx`, `tasks-ui/TaskRow.tsx` | `TaskList.test.tsx`, `tasks-ui/TaskRow.test.tsx` |
| Filtri: testo, progetto, stato, traguardo (e in più reparto, assegnatario, taglia, periodo, ferma) nell'indirizzo | `tasks-ui/FilterBar.tsx`, `domain/filters.ts` | `tasks-ui/FilterBar.test.tsx`, `domain/filters.test.ts`, `TasksPage.test.tsx` |
| Filtri per tipo e priorità | `tasks-ui/FilterBar.tsx` (chip «Type», «Priority»), `domain/filters.ts` (`matches`, `parseCriteria`) | `tasks-ui/FilterBar.test.tsx`, `domain/filters.test.ts` |
| Raggruppamento, ordinamento, selezione multipla e azioni in blocco | `pages/tasks/grouping.ts`, `BulkBar.tsx` | `grouping.test.ts`, `TaskList.test.tsx` |
| Viste salvate: salva (nome, «condividi» = pubblico), applica, modifica/elimina le proprie, le altrui solo applicabili | `pages/filters/*`, `SaveFilterDialog.tsx` | `SaveFilterDialog.test.tsx`, `FilterPage.test.tsx`, `AllFiltersPage.test.tsx`, `data/mutations.test.ts` |
| Nuovo ticket (titolo, progetto, tipo, priorità, descrizione; permesso `tickets.create`) | `pages/task/NewTaskDialog.tsx` | `NewTaskDialog.test.tsx` |
| Stati vuoto / errore / «Mostra tutto» | `tasks-ui/PageStates.tsx`, `TasksPage.tsx` | `PageStates.test.tsx`, `TasksPage.test.tsx` |
| Caricamento a pagine («Load more») | non serve: dati locali, elenco intero | — |
| Board: colonne per stato, trascinamento (mouse e tastiera), ottimistico con rollback, apre la carta | `pages/tasks/TaskBoard.tsx` | `TaskBoard.test.tsx` |
| Board: filtro progetto, corsie | barra dei filtri; corsie per assegnatario/reparto | `TaskBoard.test.tsx`, `TasksPage.test.tsx` |

## Dettaglio ticket (non-AI)

| Voce | Dove | Test |
|---|---|---|
| Testata: codice, titolo, stato, priorità, tipo, progetto, traguardo (taglia al posto dello sforzo 1–5) | `pages/task/TaskHeader.tsx` | `TaskDetail.test.tsx` (apertura, stato), `TaskDetailSections.test.tsx` (campi) |
| Esporta come Markdown: «Copy as Markdown», «Download `<CODE>.md`» (campi, descrizione, task collegate nei due versi, decisioni aperte/chiuse, commenti; eliminati come «Comment deleted»); letture fallite → messaggio e «Retry» nel menu | `pages/task/TaskMoreMenu.tsx`, `domain/export.ts` (`taskToMarkdown`), `tasks-ui/exportFile.ts` | `domain/export.test.ts`, `TaskDetailSections.test.tsx` |
| Origine (SDK, API, Slack, Webhook, Widget, Email, Automazione) con segno e parola, ×occorrenze | `TaskHeader.tsx` (campo «Source»), `tasks-ui/SourceMark.tsx` | `TaskDetailSections.test.tsx` |
| Payload tecnico (richiudibile) | `pages/task/TechnicalSection.tsx` | `TaskDetailSections.test.tsx` |
| «View conversation» delle task del widget | — | **area 8** (Support): nessun link morto |
| Descrizione (markdown): modifica e salvataggio | `DescriptionSection.tsx` | `TaskDetailSections.test.tsx` |
| Richiesta d'origine: si mostra e apre la richiesta | `LinksSection.tsx` (`OriginRequest`) | `TaskDetailSections.test.tsx` |
| Task collegate: una riga salvata (blocca, correlata, padre, come la relazione del web), inversi ricavati in lettura (bloccata da, figlia, correlata dall'altra parte); aggiungi dai tre versi salvati, rimuovi con conferma (chi può modificare la task che tiene la riga) | `LinksSection.tsx`, `domain/links.ts` (`linksOf`) | `TaskDetailSections.test.tsx`, `domain/links.test.ts`, `data/mutations.test.ts`, `data/seed.test.ts` |
| Allegati (elenco, aggiungi finto, rimuovi con conferma) | `LinksSection.tsx` (`Attachments`) | `TaskDetailSections.test.tsx`, `data/mutations.test.ts` |
| Feed attività: commenti e risposte | `ActivityFeed.tsx` | `TaskDetailSections.test.tsx`, `data/mutations.test.ts` |
| Feed attività: modifica di un commento | `ActivityFeed.tsx` | `data/mutations.test.ts` (UI: nessun test) |
| Feed attività: eliminazione («Comment deleted · by») | `ActivityFeed.tsx` | `TaskDetail.test.tsx`, `data/mutations.test.ts` |
| Feed attività: cambi di campo | `ActivityFeed.tsx` | `TaskDetail.test.tsx`, `data/mutations.test.ts` |
| Barra laterale: stato, priorità, tipo, assegnatario, traguardo, etichette (patch con `tickets.edit`; sola lettura senza) | `TaskHeader.tsx` | `TaskDetail.test.tsx`, `TaskDetailSections.test.tsx`, `data/mutations.test.ts` |
| Segui | `TaskHeader.tsx` | `data/mutations.test.ts` (UI: nessun test) |
| Ferma e motivo: «Mark as stalled» con motivo e nota, «Not stalled anymore»; «bloccata da» ricavato dalle righe «blocks» delle altre task (si sblocca quando la bloccante si chiude) | `StallControl.tsx`, `domain/stalled.ts` | `TaskDetailSections.test.tsx`, `domain/stalled.test.ts`, `data/mutations.test.ts` |
| Richieste di decisione (nuove dell'area) | `DecisionSection.tsx`, `AskDecisionDialog.tsx` | `TaskDetail.test.tsx` |
| Piano, approvazione, domande dell'agente, avvio AI, storia del lavoro, attività AI, uso AI, correzioni, PR/cicli, adozione PR | `ClaudeSection.tsx` | fatto nell'area 3: `area3-parity.md`, «Dettaglio ticket — parti AI» (uso AI e adozione PR: buchi lì) |
| Repository / PR / «N repos» | `ClaudeSection.tsx` (righe PR) | area 3: `area3-parity.md` (il badge «N repos» è un buco lì) |

## Backlog → Requests

| Voce | Dove | Test |
|---|---|---|
| Elenco con titolo, stato, urgenza, taglia, «richiesta N volte», simili, task collegate; filtri testo/stato | `pages/requests/RequestsPage.tsx`, `marks.tsx` | `RequestsPage.test.tsx` |
| Codice di catalogo `<PROGETTO>-R<n>` (R-D1, nuovo rispetto al web): sequenza per progetto data alla creazione, mai riusata, tenuta da fuse e archiviate; nella colonna fissa dell'elenco (con le intestazioni delle colonne), nel pannello, nell'export (titolo e nome del file `STW-R3.md`), in ⌘K (per codice e titolo, solo progetti visibili, apre `?request=`) e nel blocco «New requests» della Home | `data/model.ts` (`ProjectRequest.code`), `data/seed/requests.ts`, `data/api-mutations.ts` (`createRequest`), `data/api.ts` (`search`), `RequestsPage.tsx`, `RequestDetail.tsx`, `domain/export.ts`, `palette/CommandPalette.tsx`, `pages/home/blocks/DecideBlock.tsx` (`RequestItem`) | `data/mutations.test.ts`, `data/api.test.ts`, `data/seed.test.ts`, `RequestsPage.test.tsx`, `CommandPalette.test.tsx`, `HomePage.test.tsx`, `domain/export.test.ts` |
| Nuova richiesta | `NewRequestDialog.tsx` | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Voce: stato, urgenza, richiedenti, simili, task nate | `RequestDetail.tsx` | `RequestsPage.test.tsx` |
| Metadati: urgenza modificabile, taglia XS–XL (al posto dello sforzo E1–E5), rischio, nota sul rischio (`backlog.edit`; sola lettura senza; trasformata o archiviata: rifiutati anche dal «server») | `RequestDetail.tsx` (`Metadata`), `marks.tsx` (`RiskMark`), `data/api-mutations.ts` (`updateRequest`) | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Esporta come Markdown: «Copy as Markdown», «Download .md» (titolo «STW-R3 · …», file `STW-R3.md`) | `RequestDetail.tsx` (menu «More actions», per tutti), `domain/export.ts` (`requestToMarkdown`) | `domain/export.test.ts`, `RequestsPage.test.tsx` |
| Converti in task (la task nasce con la taglia della richiesta) | `RequestDetail.tsx` + `NewTaskDialog` | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Fondi in… (simili per prime) | `MergeDialog.tsx` | `MergeDialog.test.tsx`, `RequestsPage.test.tsx` |
| Archivia / Riapri (con Annulla) | `RequestDetail.tsx` | `RequestsPage.test.tsx` |
| Refinement: avvio e stato | `RequestDetail.tsx` (`useStartRefine`) | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Conversazione di refinement, design/piano a lato | `RefineView.tsx`, `ObjectSide.tsx` | fatto nell'area 3: `area3-parity.md`, «Backlog → sessione di refinement» (suggerimenti AI e prossimo passo: buchi lì) |

## Projects

| Voce | Dove | Test |
|---|---|---|
| Elenco con polso, «Needs you» davanti, poi alfabetico | `pages/projects/AllProjectsPage.tsx`, `pages/overview/pulseLine.ts` | `AllProjectsPage.test.tsx`, `OverviewPage.test.tsx` |
| Ferme (con giorni e motivo) | `PortfolioStalled.tsx`, `pages/overview/StalledSection.tsx` | `AllProjectsPage.test.tsx`, `OverviewPage.test.tsx`, `domain/stalled.test.ts` |
| Nuovo progetto (poi si atterra sull'Overview) | `NewProjectDialog.tsx` | `AllProjectsPage.test.tsx`, `data/mutations.test.ts` |
| Fissa/sgancia (≈ Segui/Non seguire il progetto) | riga progetto | `AllProjectsPage.test.tsx` |
| Impostazioni progetto: stati, soglie «ferma» | `pages/settings/*` | `ProjectSettingsPage.test.tsx`, `data/mutations.test.ts` |
| Impostazioni progetto: AI, repository, membri, integrazione, widget, regole mail, server, ambienti, plugin, elimina | — | **area N** (aree 3–9) |
| Traguardi: elenco, progresso, scadenza e «in ritardo», crea, modifica, chiudi/riapri, elimina | `overview/ProgressSection.tsx`, `MilestonesDialog.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Roadmap: cronologia per settimana, filtro per tipo, apre brief e PR | `overview/ProjectTimeline.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Brief settimanale: periodo, data, testo (etichettato «Generated text»), lettura | `overview/BriefCard.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Brief: «Copy as text» (sulla carta e nel pannello; il testo copiato dice ancora «Generated text») | `overview/BriefCard.tsx` (`CopyBriefButton`), `domain/export.ts` (`markdownToText`) | `OverviewPage.test.tsx`, `domain/export.test.ts` |
| Brief: «Rigenera» | — | buco dell'area 3 (`area3-parity.md`, «Buchi» n. 7): non costruito |
| Registro decisioni: lettura, fonti, superata da | `overview/DecisionLog.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Registro decisioni: registra a mano (`decisions.record`) | `DecisionLog.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Registro decisioni: «Superseded by» modificabile su una voce esistente (stesso progetto, non sé stessa, niente giri) | `DecisionLog.tsx` (`EntryMenu`), `domain/decisionLog.ts`, `data/api-mutations.ts` (`setDecisionSuperseded`) | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Attività trasversale per giorno | `projects/ActivityFeed.tsx` | `AllProjectsPage.test.tsx`, `data/overview.test.ts` |
| Activity «standup giornaliero»: selettore data, schede per progetto/sviluppatore, commit con descrizione AI, stato del report, «Generate report», «Link team member» | `pages/projects/PeopleActivity.tsx` (scheda «By person» di Activity) | fatto nell'area 3: `area3-parity.md`, «Activity per sviluppatore» |
| Conversazioni del widget | — | **area 8** (Support) |

## Buchi

Nessuno. I buchi trovati dal Task 15 sono stati chiusi dal Task 16
(regole R-C1–R-C4 del controller) e stanno ora nelle tabelle sopra:

1. Esporta la task come Markdown → «Dettaglio ticket».
2. Esporta la richiesta come Markdown → «Backlog → Requests».
3. Brief «Copy as text» → «Projects».
4. Metadati della richiesta (R-C1: taglia al posto dello sforzo E1–E5,
   rischio, nota, urgenza modificabile) → «Backlog → Requests».
5. Filtri per tipo e priorità → «Tickets → Tasks».
6. Origine, ×occorrenze e dati tecnici (R-C2) → «Dettaglio ticket»;
   «View conversation» → **area 8**.
7. Activity «standup giornaliero» → fatto nell'area 3 (`area3-parity.md`).
8. «Superseded by» modificabile → «Projects».
