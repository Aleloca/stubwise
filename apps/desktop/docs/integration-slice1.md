# Integrazione area 2, fetta 1 — parità col prototipo (9 nov 2026)

Cosa della `area2-parity.md` funziona sul server vero nella **build app**
(desktop e `/app`), e cosa resta al prototipo fino a una fetta successiva.
Design: `docs/plans/2026-11-09-integrazione-area2-task-design.md`; piano:
`docs/plans/2026-11-09-integrazione-area2-task-plan.md`.

Percorsi del renderer relativi a `apps/desktop/src/renderer/`; «real/» è
`data/backend/real/`, l'implementazione vera dietro `@backend/api`. Le rotte
sono di `apps/server/src/routes/`. Il prototipo (dati finti) resta com'era:
la stessa pagina gira sui due livelli dati, e i test del prototipo (in
`pages/…`, `tasks-ui/…`, `data/…`) continuano a coprirne il comportamento.
I test «app» montano l'implementazione vera davanti a un server finto
(`real/fakeServer.ts`).

## Tickets → Tasks

| Voce di `area2-parity.md` | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Elenco: riga con codice, titolo, stato, taglia, scadenza, segno «ferma» | `pages/tasks/TaskList.tsx`, `tasks-ui/TaskRow.tsx`; `real/tasks.ts` (`listTasks`, `toTask`) | `GET /api/tasks` | `real/tasks.test.ts`, `real/taskPanel.test.tsx`; server `tasks.read.test.ts` |
| Filtri (testo, progetto, stato, reparto, assegnatario, taglia, tipo, priorità, periodo, ferma) nell'indirizzo | `tasks-ui/FilterBar.tsx`, `domain/filters.ts`; `real/tasks.ts` (`filtersOf`) | `GET /api/tasks?<taskListQuerySchema>` | `real/tasks.test.ts` («listTasks passa i criteri come query»); server `tasks.read.test.ts` |
| Raggruppamento, ordinamento, selezione multipla e azioni in blocco | `pages/tasks/grouping.ts`, `BulkBar.tsx`; `real/tasks.ts` (`bulkUpdateTasks`) | `PATCH /api/tasks/bulk` | `grouping.test.ts`, `TaskList.test.tsx`; server `tasks.write.test.ts` |
| Nuova task (titolo, progetto, reparto, descrizione, assegnatario, taglia, stato, traguardo, tipo, priorità) | `pages/task/NewTaskDialog.tsx`; `real/tasks.ts` (`createTask`) | `POST /api/tasks` | `NewTaskDialog.test.tsx`; server `tasks.write.test.ts` |
| Stati vuoto / errore | `tasks-ui/PageStates.tsx`, `TasksPage.tsx` | — | `TasksPage.test.tsx` |
| Board: colonne per stato del progetto, trascinamento ottimistico con ritorno indietro | `pages/tasks/TaskBoard.tsx`; `real/tasks.ts` (`updateTask` con `statusId`) | `PATCH /api/tasks/:id` | `TaskBoard.test.tsx`; server `tasks.write.test.ts` |
| Ferme (motivi automatici e a mano) | `domain/stalled.ts` → `@stubwise/shared` (`stallOf`); `real/tasks.ts` (`listStalled`, `toStallReason`) | `GET /api/tasks/stalled` | `packages/shared/src/tasks/stall.test.ts`, `real/tasks.test.ts`; server `tasks.read.test.ts` |

## Dettaglio della task

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Testata e campi: stato, priorità, tipo, reparto, assegnatario, taglia, scadenza, traguardo, etichette | `pages/task/TaskHeader.tsx`; `real/tasks.ts` (`getTaskByCode`, `updateTask`) | `GET /api/tasks/by-code/:code`, `PATCH /api/tasks/:id` | `TaskDetail.test.tsx`, `TaskDetailSections.test.tsx`, `real/taskPanel.test.tsx`; server `tasks.read.test.ts`, `tasks.write.test.ts` |
| Task invisibile aperta da link (`?task=CODE`): pannello «not found» | `pages/task/TaskDetail.tsx`; `real/tasks.ts` (404 → `null`) | `GET /api/tasks/by-code/:code` (404) | `real/taskPanel.test.tsx`, `real/tasks.test.ts`; server `tasks.read.test.ts` |
| Esporta come Markdown | `pages/task/TaskMoreMenu.tsx`, `domain/export.ts` | (letture sopra) | `domain/export.test.ts` |
| Origine e payload tecnico | `TaskHeader.tsx` («Source»), `pages/task/TechnicalSection.tsx` | `GET /api/tasks/by-code/:code` (`source`, `technical`) | `TaskDetailSections.test.tsx` |
| Descrizione: modifica e salvataggio | `DescriptionSection.tsx` | `PATCH /api/tasks/:id` | `TaskDetailSections.test.tsx` |
| Richiesta d'origine (lettura) | `LinksSection.tsx` (`OriginRequest`); `real/taskDetail.ts` (`getRequest`) | `GET /api/backlog/:id` | `TaskDetailSections.test.tsx` (prototipo) |
| Task collegate: aggiungi, rimuovi con conferma, inversi ricavati | `LinksSection.tsx`, `domain/links.ts`; `real/taskDetail.ts` (`addLink`, `removeLink`) | `POST`/`GET /api/tickets/:id/links`, `DELETE /api/tickets/:id/links/:linkId` | `real/tasks.test.ts` («relates diventa relates_to e ritorno»), `domain/links.test.ts`; server `tickets.test.ts` |
| Allegati: elenco, aggiungi (un file vero), rimuovi con conferma | `LinksSection.tsx` (`Attachments`); `real/attachments.ts` | `POST /api/tickets/:ticketId/attachments`, `DELETE /api/attachments/:id` | `real/taskPanel.test.tsx`, `real/tasks.test.ts` («allegati spenti…»); server `attachments.test.ts` |
| Feed attività: commenti e risposte, modifica, eliminazione, cambi di campo, decisioni | `ActivityFeed.tsx`; `real/taskDetail.ts` (`listActivity`, `addComment`, `editComment`, `deleteComment`) | `GET /api/tasks/:id/activity`, `/api/tickets/:id/comments[/:commentId]` | `TaskDetail.test.tsx`, `TaskDetailSections.test.tsx`; server `tasks.read.test.ts` |
| Segui | `TaskHeader.tsx` (`useInlineWrite` → `followTask`); `real/tasks.ts` | `PUT`/`DELETE /api/tasks/:id/follow` | `data/architecture.test.ts` (nessuna pagina passa `followerIds` a `updateTask`); server `tasks.write.test.ts` |
| Ferma a mano: «Mark as stalled» con motivo e nota, «Not stalled anymore» | `StallControl.tsx`; `real/tasks.ts` (`setManualStall`, `clearManualStall`) | `PUT`/`DELETE /api/tasks/:id/manual-stall` | `TaskDetailSections.test.tsx`; server `tasks.write.test.ts` |
| Richieste di decisione: chiedi, rispondi, ritira, più richieste aperte | `DecisionSection.tsx`, `AskDecisionDialog.tsx`; `real/taskDetail.ts` | `POST /api/tasks/:id/decisions`, `GET /api/decisions`, `POST /api/decisions/:id/answer`, `POST /api/decisions/:id/withdraw` | `TaskDetail.test.tsx`; server `decisions.test.ts` |
| Sezione Claude: stato reale, PR, «Open in web» | `pages/task/ClaudeSection.tsx` (`ClaudeSummarySection`); `real/taskDetail.ts` (`getTaskWorkSummary`) | `GET /api/tasks/:id/work` | `real/taskPanel.test.tsx`, `pages/ComingSoon.test.tsx`; server `tasks.read.test.ts` |

## Progetto, reparti, ossatura

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Impostazioni progetto: stati (aggiungi, rinomina, riordina, elimina con spostamento) e soglie «ferma» | `pages/settings/ProjectStatusesSettings.tsx`; `real/statuses.ts` | `GET`/`PUT /api/projects/:id/statuses`, `PUT /api/projects/:id/stall-thresholds` | `ProjectSettingsPage.test.tsx`; server `project-statuses.test.ts` |
| Fissa/sgancia un progetto | `layout/Rail.tsx`, riga progetto; `real/projects.ts` (`listPinnedProjectIds`, `setPinned`) | `GET`/`PUT /api/me/follows` | `layout/Rail.test.tsx`, `real/sessionLost.test.tsx` |
| Progetti visibili, codici, membri effettivi (assegnatari) | `real/projects.ts` (`listProjects`, `getProjectByCode`) | `GET /api/projects` (`code`, `memberIds`, `stallThresholds`) | server `projects.test.ts`, `derived-fields.test.ts` |
| Traguardo: si assegna (dettaglio, nuova task, blocco, filtro) | `TaskHeader.tsx`, `NewTaskDialog.tsx`, `BulkBar.tsx`; `real/statuses.ts` (`listMilestones`) | `GET /api/milestones?projectId` | server `milestones.test.ts` |
| Amministrazione → Reparti: nome, colore, membri, elimina con spostamento | `pages/admin/DepartmentsPage.tsx`, `DepartmentPanel.tsx`; `real/departments.ts` | `GET`/`POST /api/departments`, `PATCH`/`DELETE /api/departments/:id` | `real/departments.test.ts`, `RolesDepartments.test.tsx`; server `departments.test.ts` |
| Persone | `real/people.ts` (`listPeople`) | `GET /api/people` | `real/session.test.ts`; server `people.test.ts` |
| Chi guarda e i suoi permessi (dal server, mai dedotti) | `data/viewing.ts` (`AppViewerProvider`); `real/session.ts` | `GET /api/auth/me` | `real/session.test.ts`, `data/backend/appViewer.test.tsx` |
| Sessione scaduta a metà: login, cache svuotata | `data/viewing.ts`, `data/sessionEvents.ts`; `real/client.ts` | qualunque `401` | `real/sessionLost.test.tsx` |
| Notifiche: la stessa inbox, «letta» condivisa; aree integrate aprono la task, le altre «Open in web» | `notifications/*`, `platform/openWeb.ts`; `real/notifications.ts` (`presentInboxItem`) | `GET /api/inbox`, `POST /api/inbox/:id/read\|snooze\|handled` | `real/session.test.ts`, `real/derivedFields.test.ts`, `notifications/NotificationsPanel.test.tsx`; server `inbox.test.ts`, `notification-kinds.test.ts` |
| Ricerca di ⌘K: task e progetti | `palette/CommandPalette.tsx`; `real/search.ts` | `GET /api/search` | `palette/CommandPalette.test.tsx` (prototipo); server `search.test.ts` |
| Aree non integrate «Coming soon», nessuna loro lettura | `data/integration.ts`, `layout/AppLayout.tsx` (`IntegrationGate`), `pages/Placeholder.tsx` | — | `data/integration.test.ts`, `pages/ComingSoon.test.tsx` |
| Login web (password, codice, codice di riserva, passkey) | `pages/entry/LoginPage.tsx`, `SecondFactorStep.tsx`; `real/webLogin.ts` | `POST /api/auth/login`, `/api/auth/second-factor/*` | `real/webLogin.test.ts`, `real/loginFlow.test.tsx`; server `second-factor-login.test.ts` |
| Nessun dato del seed nel bundle app | `vite.backend.ts` (alias `@backend/*`), `scripts/check-no-seed.mjs` | — | `scripts/check-no-seed.test.mjs`, `data/backend/seam.test.ts`, `data/architecture.test.ts`; CI e `Dockerfile.caddy` |

## Rimandate

| Voce | Fetta |
|---|---|
| Planning (di progetto e trasversale), La mia settimana, slittamento, vista Timeline, campo «settimana» | 2 |
| Home a blocchi, «Da decidere», filtri salvati («Salva come filtro», viste salvate) | 3 |
| Requests (elenco, codici `R<n>`, metadati, conversione, fusione, refinement), Overview, gestione dei traguardi (crea, modifica, chiudi, elimina), Tutti i progetti, cronologia, brief, registro decisioni | 4 |
| Claude completo (assegna, avvia, piano, domande, sessione dal vivo, correzioni) | area 3 |
| Altre impostazioni di progetto e il resto dell'amministrazione | aree 3–9 |

## Aggiunte rispetto al prototipo

- **Configurazione del secondo fattore al login** (`pages/entry/EnrollAtLoginStep.tsx`): chi non ha l'app di autenticazione la configura prima di entrare, perché ogni porta che apre una sessione passa dal secondo fattore (`/second-factor/enroll`, `/enroll/confirm`): QR, chiave, primo codice, codici di riserva una volta. Non c'è nel prototipo (maintainer).
- **Passo dell'indirizzo dell'istanza** sul desktop (`pages/entry/DesktopEntry.tsx`), coi componenti dell'ingresso esistenti (maintainer).
- **Ingresso del desktop dal browser** (`pages/entry/DesktopEntry.tsx`, `platform/desktopSession.ts`, `src/main/browserLogin.ts`): indirizzo → «Sign in with your browser» → attesa; nessun campo password nel desktop (maintainer).
- **Pagina `/app/#/desktop-login`** con «Allow» (`pages/entry/DesktopLoginPage.tsx`): conferma esplicita che apre la sessione del desktop (maintainer).
- **Frase del reparto di ripiego**: «This is the default department… renamed but not deleted» (`admin.departments.errors.defaultDepartment`, costruttore).

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Lo stato vero è `tickets.status_id` (stati per progetto); l'enum `tickets.status` è derivato da un trigger, per web vecchio, mobile, MCP e pipeline | maintainer |
| Taglie sulla colonna `effort` esistente: 1→XS, 2→S, 3→M, 4→L, 5→XL | costruttore (design) |
| Tre tipi in UI (bug, funzionalità, attività); `feedback` si legge come funzionalità, `review` come attività | maintainer |
| Una task creata dall'app nuova non è mai deviata nell'intake del backlog | costruttore (design) |
| «General» è il reparto di ripiego: non si elimina, e le persone nuove ci entrano da sole | maintainer |
| I follower partono da ora (nessun backfill); i cambi automatici della pipeline non li notificano | costruttore («Segui» è del maintainer) |
| Il webhook d'istanza è spento per i tre kind nuovi (`decision.requested`, `decision.answered`, `ticket.activity`) | orchestratrice |
| I cambi di reparto e di taglia non entrano nel feed attività (superata dalla fetta 2: ci entrano, con la settimana; `integration-slice2.md`) | orchestratrice |
| L'elenco si ferma a 2000 righe; `truncated` non si mostra (il prototipo non ha uno stato per questo) | costruttore |
| Claude non è assegnabile (area 3) | maintainer |
| Nessuna riconferma sui reparti; un PAT non soddisfa mai la riconferma (limite per le fette che la chiederanno dal desktop) | orchestratrice |
| Notifiche: «Restore» e «Move to New» nascosti, «segna come non letta» non supportato dal server | orchestratrice |
| Il server non dice quanti tentativi del secondo fattore restano: si mostra la frase generica | orchestratrice |
| Niente download degli allegati sul desktop (la rotta risponde 302 verso un URL presigned) | costruttore |
| Gli allegati riusano lo storage S3 di oggi: 10 MB, allowlist dei tipi, stessi allegati di web e mobile | costruttore (design) |
| Il login web è completo dentro `/app` | maintainer |
| Il login del desktop passa dal browser con PKCE; `desktop-handoff` chiede la riconferma | maintainer |
| I token desktop si revocano al cambio della password, come quelli mobile | orchestratrice |
| `dueDate` è una colonna nuova (`0111_ticket_due_date.sql`) e si imposta solo dal dettaglio (non in creazione né in blocco) | orchestratrice |
| Un motivo di ferma ignoto (`UNKNOWN`) non si mostra fra le ferme | costruttore |
| `INSTANCE_ORIGIN` finto («stubwise.example.test») resta nel bundle solo per la pagina Google, «in arrivo» | costruttore |

## Da provare a mano

- Il giro vero sul Mac: dmg (`package:mac`) → indirizzo dell'istanza → browser (`/app/#/desktop-login`, «Allow») → ritorno con `stubwise://` → dentro l'app.
- La revisione visiva delle pagine nuove: ingresso del desktop e attesa, conferma `/app/#/desktop-login`, configurazione del secondo fattore al login, sezione Claude del dettaglio nella build app.
