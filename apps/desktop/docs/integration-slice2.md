# Integrazione area 2, fetta 2 — parità col prototipo (9 nov 2026)

Cosa della `area2-parity.md` funziona sul server vero nella **build app**
(desktop e `/app`) con la fetta 2: Planning, La mia settimana, Timeline,
settimana e slittamento. Il resto resta al prototipo fino a una fetta
successiva. Design: `docs/plans/2026-11-09-integrazione-area2-fetta2-design.md`;
piano: `docs/plans/2026-11-09-integrazione-area2-fetta2-plan.md`. Quello che
la fetta 1 ha già portato sul server sta in `integration-slice1.md`.

Le convenzioni sono quelle della fetta 1:
- i percorsi del renderer sono relativi a `apps/desktop/src/renderer/`;
- «real/» è `data/backend/real/`, l'implementazione vera dietro `@backend/api`;
- le rotte sono di `apps/server/src/routes/`.

Il prototipo resta com'era: le regole di carico e di pianificazione stanno
ora in `@stubwise/shared` (`packages/shared/src/tasks/{weeks,load,planning}.ts`),
e `domain/{weeks,load,planning}.ts` le riesportano, così prototipo, server e
build app usano la stessa funzione. I test «app» montano l'implementazione
vera davanti a un server finto (`real/fakeServer.ts`).

## Settimana e slittamento

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Settimana pianificata di una task (campo «Week» nel dettaglio, in blocco, in creazione) | `pages/task/TaskHeader.tsx`, `pages/tasks/pickers.tsx`, `BulkBar.tsx`, `pages/task/NewTaskDialog.tsx`; `real/tasks.ts` (`updateTask`, `bulkUpdateTasks`, `createTask` con `plannedWeek`) | `PATCH /api/tasks/:id`, `PATCH /api/tasks/bulk`, `POST /api/tasks` | `real/planning.test.tsx` («la settimana entra in updateTask e in createTask»); server `tasks.write.test.ts`, `tasks.plan.test.ts` («PATCH resta su tickets.edit…») |
| Slittamento: una task aperta di una settimana passata sta nella corrente, col conteggio delle settimane | `domain/weeks.ts` → `@stubwise/shared` (`slipOf`); `real/tasks.ts` (`toTask` legge `plannedWeek` e `slipCount`) | `GET /api/tasks` (settimana effettiva e `slipCount` derivati) | `packages/shared/src/tasks/weeks.test.ts`, `real/planning.test.tsx` («toTask legge settimana, slittamento e canPlan»); server `tasks.read.test.ts` («una task aperta della settimana scorsa è nella corrente con slipCount 1…»), `packages/db/src/migration-0113.test.ts` (W53 → W01, ripianificare una slittata) |
| Filtro di periodo sulla settimana | `tasks-ui/FilterBar.tsx`; `real/tasks.ts` (`filtersOf`) | `GET /api/tasks?periodField=plannedWeek…` | server `tasks.read.test.ts` (il filtro trova la slittata nella corrente) |

## Planning

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Planning di progetto: «To plan» a sinistra, persone × settimane a destra | `pages/planning/PlanningPage.tsx`, `Unplanned.tsx`, `PeopleGrid.tsx`, `PlanChip.tsx` | `GET /api/tasks` | `PlanningPage.test.tsx` (prototipo), `real/planning.test.tsx`, `pages/ComingSoon.test.tsx` («le superfici della fetta 2 nella build app») |
| Planning trasversale per reparto (`/planning`), solo con `planning.others` in almeno un progetto; senza, si torna a La mia settimana | `router.tsx` (`PlanningRoutePage`), `PlanningPage.tsx` | `GET /api/tasks`, `GET /api/auth/me` | `PlanningPage.test.tsx`, `pages/ComingSoon.test.tsx` («/planning senza planning.others torna a My week») |
| Spostare con trascinamento, menu «Plan» e tastiera, ottimistico con ritorno indietro e messaggio | `PlanningPage.tsx` (`plan`), `PlanMenu.tsx`; `data/queries.ts` (`usePlanTask`); `real/planning.ts` (`planTask`) | `POST /api/tasks/:ticketId/plan` | `real/planning.test.tsx` («planTask 403 riporta indietro l'ottimistico con il messaggio»); server `tasks.plan.test.ts` |
| Chi può spostare una task (la carta) | `PlanChip.tsx` (`task.canPlan ?? canMove`); `real/tasks.ts` (`toTask` legge `canPlan`) | `GET /api/tasks` (`canPlan`) | `real/planning.test.tsx` («canPlan del server decide la sola lettura»); server `tasks.plan.test.ts` («falso sulle task altrui per il Developer…») |
| Righe altrui in sola lettura, bersagli ammessi del menu e del rilascio | `PlanningPage.tsx`, `PlanMenu.tsx`, `PeopleGrid.tsx`, `Unplanned.tsx` (`planBlock` coi permessi del server) | `GET /api/auth/me` (permessi per progetto) | `PlanningPage.test.tsx`, `packages/shared/src/tasks/planning.test.ts`; server `tasks.plan.test.ts` |
| Carico per persona e settimana (taglie pesate, cella più carica, task senza stima) | `domain/load.ts`, `domain/planning.ts` → `@stubwise/shared` (`peopleLoad`, `busiestCell`) | `GET /api/tasks` | `packages/shared/src/tasks/load.test.ts`, `planning.test.ts`, `PlanningPage.test.tsx` |
| Avviso quando la lista del carico è troncata | `PlanningPage.tsx`, `data/queries.ts` (`tasksTruncated`); `real/tasks.ts` | `GET /api/tasks` (`truncated`) | `real/tasks.test.ts` («tasksTruncated…»), `pages/ComingSoon.test.tsx` |
| Avvisi a chi è spostato o riceve la task, che aprono il pannello della task | `real/notifications.ts` (`INTEGRATED_KINDS`: `planning.changed`, `task.assigned`) | `GET /api/inbox` | `real/planning.test.tsx` («planning.changed e task.assigned aprono il pannello»); server `tasks.plan.test.ts` (chi riceve quale avviso, mai l'attore), `packages/notifications/src/routing.test.ts` |

## La mia settimana

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| La mia settimana (`/home?view=week`): le mie task della settimana e il carico | `pages/week/MyWeekPage.tsx`, `WeekBoard.tsx` (`useMyWeek`) | `GET /api/tasks?assigneeIds=…` | `MyWeekPage.test.tsx` (prototipo), `real/loginFlow.test.tsx`, `pages/ComingSoon.test.tsx` |
| Sistemare una task in un giorno (lunedì–venerdì) o senza giorno | `WeekBoard.tsx`; `data/queries.ts` (`useSetDay`); `real/planning.ts` (`setDay`, `listDayArrangements`) | `PUT /api/tasks/:ticketId/day`, `GET /api/me/day-arrangements?week=` | `real/planning.test.tsx` («setDay di una task non mia non parte», «setDay della mia task…»); server `day-arrangements.test.ts` |
| Colonna della Home: «My week» e «Planning» disponibili, il resto «in arrivo» | `layout/PersonalColumn.tsx`, `data/integration.ts` (`integrationTargetOf`, `my-week`) | — | `pages/ComingSoon.test.tsx`, `data/integration.test.ts` |
| Avviso «troncato» accanto al carico | `MyWeekPage.tsx` | `GET /api/tasks` (`truncated`) | `real/planning.test.tsx` («troncato: l'avviso compare») |

## Timeline

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Vista Timeline delle task di progetto (settimane, traguardi) | `pages/tasks/TaskTimeline.tsx`, `TasksPage.tsx`; `data/integration.ts` (`taskView: timeline`) | `GET /api/tasks`, `GET /api/milestones` | `TaskTimeline.test.tsx`, `pages/ComingSoon.test.tsx` («la Timeline è disponibile») |

## Feed della task

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Cambi di settimana, reparto e taglia nel feed (aggiorna la riga della fetta 1 «reparto e taglia non entrano nel feed») | `pages/task/ActivityFeed.tsx` (settimana corta con `shortWeekIn`) | `GET /api/tasks/:id/activity` | server `tasks.read.test.ts` |
| Assegnatario e traguardo per nome; persona, traguardo o reparto eliminati diventano «someone», «a deleted milestone», «a deleted department» (mai un id) | `ActivityFeed.tsx` (`isGoneRef`); i18n `taskDetail.activity.gone.*` | `GET /api/tasks/:id/activity` (id così com'è per un'entità che non esiste più) | `real/planning.test.tsx` («chi o cosa non esiste più non mostra mai un id; null resta «tolto»»); server `tasks.read.test.ts` («assignee_changed mostra i nomi…») |

## Rimandate

| Voce | Fetta |
|---|---|
| Home a blocchi, «Da decidere», filtri salvati; `/home` senza `view=week` resta «in arrivo» (anche il blocco «My week», `pages/week/MyWeekBlock.tsx`) | 3 |
| Requests, Overview, gestione dei traguardi (crea, modifica, chiudi, elimina) | 4 |
| Claude come riga del Planning (e assegnabile) | area 3 |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| `planning.others` ce l'hanno Project Lead e full admin, non Developer né Legacy Member (né Contributor e Viewer) | maintainer |
| `planBlock` vale solo sulla rotta `plan`, come il prototipo: PATCH e bulk restano su `tickets.edit` anche per settimana e assegnatario | maintainer |
| La settimana è il lunedì nel DB (`tickets.planned_week date`) e `YYYY-Www` sul filo | costruttore (design) |
| Il fuso della settimana corrente è `Europe/Rome`, anche per «oggi» delle ferme | costruttore (design) |
| Lo slittamento si deriva a lettura (nessun job) e si consolida in `slip_count` a ogni ripianificazione a mano; una task chiusa si ferma alla settimana di chiusura (mai slittata né in «To plan») | orchestratrice (design) |
| Il carico si calcola nel renderer con i moduli condivisi; oltre le 2000 righe la lista è troncata e lo si dice («Some tasks are missing from the load.») | orchestratrice |
| La sistemazione per giorno è personale (solo l'assegnatario la legge e la scrive) e un trigger la azzera quando cambiano settimana o assegnatario | costruttore (design) |
| Dopo il login si atterra su La mia settimana, finché la Home a blocchi non arriva (fetta 3) | maintainer |
| Avvisi `planning.changed` e `task.assigned` (audience `task_people`); eventi e avvisi li scrive il server, il renderer non fa altro | orchestratrice |
| Nel feed un id di persona, traguardo o reparto che non esiste più diventa una frase; un valore vuoto resta «tolto» | orchestratrice |
| `canPlan` della vista decide solo la carta (si trascina, «P» apre il menu); righe in sola lettura e bersagli ammessi restano su `planBlock` coi permessi del server | costruttore |
| `setDay` non parte per una task che il renderer sa non mia; una mai letta la decide il server (403/409) | costruttore |
| Claude non è fra le righe del Planning nella build app | maintainer |

## Da provare a mano

- Trascinare nel Planning col mouse e con la tastiera («P», frecce, Invio), di progetto e trasversale, con un Project Lead e con un Developer.
- La mia settimana per giorno: mettere una task in un giorno, toglierla, rileggere la pagina.
- Lo slittamento al cambio di settimana: una task aperta della settimana scorsa compare nella corrente col segno dello slittamento.
- La Timeline con i traguardi.
- Gli avvisi a chi è spostato o riceve una task, e che aprano il pannello della task.
