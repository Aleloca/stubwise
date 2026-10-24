# Area 2 — parità con il web (23 ott 2026)

Una riga per voce dell'inventario (`web-inventory.md`) coperta dall'area 2.
Percorsi relativi a `src/renderer/`. «area N» = voce che il design assegna a
un'area successiva (spec «Non obiettivi» / «Dettaglio della task»), non un
buco. I **buchi** veri stanno in fondo.

## Tickets → Tasks

| Voce dell'inventario | Dove vive ora | Test |
|---|---|---|
| Elenco: riga con codice, titolo, stato, taglia, scadenza, segno «ferma» | `pages/tasks/TaskList.tsx`, `tasks-ui/TaskRow.tsx` | `TaskList.test.tsx`, `tasks-ui/TaskRow.test.tsx` |
| Filtri: testo, progetto, stato, traguardo (e in più reparto, assegnatario, taglia, periodo, ferma) nell'indirizzo | `tasks-ui/FilterBar.tsx`, `domain/filters.ts` | `tasks-ui/FilterBar.test.tsx`, `domain/filters.test.ts`, `TasksPage.test.tsx` |
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
| Testata: codice, titolo, stato, priorità, tipo, progetto, traguardo (taglia al posto dello sforzo 1–5) | `pages/task/TaskHeader.tsx` | `TaskDetail.test.tsx` |
| Descrizione (markdown) | `DescriptionSection.tsx` | `TaskDetail.test.tsx` |
| Richiesta d'origine | `DescriptionSection.tsx` / `parts.tsx` | `TaskDetail.test.tsx` |
| Task collegate (blocca, bloccata da, correlata, padre), aggiungi/rimuovi | `LinksSection.tsx` | `TaskDetail.test.tsx`, `data/mutations.test.ts` |
| Allegati (elenco, aggiungi, rimuovi) | `LinksSection.tsx` (`Attachments`) | `TaskDetail.test.tsx` |
| Feed attività: commenti, risposte, modifica, eliminazione («Comment deleted · by»), cambi di campo | `ActivityFeed.tsx` | `TaskDetail.test.tsx`, `data/mutations.test.ts` |
| Barra laterale: stato, priorità, assegnatario, traguardo, etichette (patch con `tickets.edit`) | `TaskHeader.tsx` | `TaskDetail.test.tsx`, `data/mutations.test.ts` |
| Segui | `TaskHeader.tsx` | `data/mutations.test.ts` |
| Ferma e motivo | `StallControl.tsx`, `domain/stalled.ts` | `domain/stalled.test.ts` |
| Richieste di decisione (nuove dell'area) | `DecisionSection.tsx`, `AskDecisionDialog.tsx` | `TaskDetail.test.tsx` |
| Piano, approvazione, domande dell'agente, avvio AI, storia del lavoro, attività AI, uso AI, correzioni, PR/cicli, adozione PR | `ClaudeSection.tsx` (solo lo stato) | **area 3** |
| Repository / PR / «N repos» | — | **area 3** |

## Backlog → Requests

| Voce | Dove | Test |
|---|---|---|
| Elenco con titolo, stato, urgenza, «richiesta N volte», simili, task collegate; filtri testo/stato | `pages/requests/RequestsPage.tsx`, `marks.tsx` | `RequestsPage.test.tsx` |
| Nuova richiesta | `NewRequestDialog.tsx` | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Voce: stato, urgenza, richiedenti, simili, task nate | `RequestDetail.tsx` | `RequestsPage.test.tsx` |
| Converti in task | `RequestDetail.tsx` + `NewTaskDialog` | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Fondi in… (simili per prime) | `MergeDialog.tsx` | `MergeDialog.test.tsx`, `RequestsPage.test.tsx` |
| Archivia / Riapri (con Annulla) | `RequestDetail.tsx` | `RequestsPage.test.tsx` |
| Refinement: avvio e stato | `RequestDetail.tsx` (`useStartRefine`) | `RequestsPage.test.tsx`, `data/mutations.test.ts` |
| Conversazione di refinement, suggerimenti AI, prossimo passo, design/piano | — | **area 3** |

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
| Brief: «Rigenera» | — | **area 3** (genera con AI) |
| Registro decisioni: lettura, fonti, superata da | `overview/DecisionLog.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Registro decisioni: registra a mano (`decisions.record`) | `DecisionLog.tsx` | `OverviewPage.test.tsx`, `data/overview.test.ts` |
| Attività trasversale per giorno | `projects/ActivityFeed.tsx` | `AllProjectsPage.test.tsx`, `data/overview.test.ts` |
| Conversazioni del widget | — | **area N** (Support) |

## Buchi (nessun posto nell'area 2, non assegnati a un'area successiva)

1. **Esporta la task come Markdown** (dettaglio ticket → Header: «Copy .md», «Download .md»).
2. **Esporta la richiesta come Markdown** (voce di backlog → menu: «Copy Markdown», «Download .md»).
3. **Brief: «Copy as text»** (Weekly brief → Actions).
4. **Metadati della richiesta**: sforzo E1–E5, rischio, nota di rischio, urgenza modificabile (voce di backlog → Metadata). L'urgenza è solo mostrata; sforzo e rischio non esistono nel modello (le taglie sostituiscono lo sforzo, il rischio no).
5. **Filtri per tipo e priorità** (Tickets list → filtri): `FilterCriteria` non li ha, benché `type` e `priority` esistano e si modifichino sulla task.
6. **Origine e dati tecnici del ticket**: badge di origine (SDK, API, Slack, Webhook, Widget), ×occorrenze, payload tecnico, «View conversation». Probabilmente area N (SDK/Support/Servers), ma il design non lo dice: serve una decisione.
7. **Activity «standup giornaliero»**: selettore data, schede per progetto/sviluppatore, commit con descrizione AI, stato del report, «Generate report», «Link team member». L'area 2 porta solo il flusso trasversale (spec §8). Dipende da repository e AI: probabile area 3, da confermare.
8. **«Superseded by» modificabile** su voci già nel registro: oggi la sostituzione avviene solo registrando una voce nuova che ne supera un'altra.
