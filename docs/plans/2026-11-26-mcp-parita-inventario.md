# Parità MCP ↔ app nuova: inventario delle azioni dell'app

26 nov 2026. Primo pezzo del lavoro «col PAT, via MCP, tutto ciò che fa la nuova app» (decisione del maintainer): l'elenco di ciò che l'app (`apps/desktop`, modo «app») legge e scrive sul server, rotta per rotta. Il design dei tool lo fa la sessione del server partendo da qui.

## Le due eccezioni

- **🗝 Cassaforte**: le password restano illeggibili per il PAT, che ne vede solo nomi e lettori. `🗝 decifra` segna le rotte che restituiscono materiale cifrato da aprire (`/reveal`); `🗝 cassaforte` le altre rotte di `/api/vault*` e delle credenziali. Nell'app queste azioni passano quasi tutte dal processo main (`window.stubwise.vault`, colonna Note), mai dal renderer.
- **🔐 reauth**: `config.reauth` sulla rotta. Un PAT non la soddisfa mai (403 `session_required`).

## Come è fatto

- **Fonte**: ogni nome pubblico di `apps/desktop/src/renderer/data/backend/real/index.ts` (lo stesso insieme di `data/api.ts`, il finto). Per i namespace (`mail`, `admin`…) i membri sono quelli del tipo del finto: un membro che il vero non ha lo riempie `partialNamespace` e risulta **in arrivo**, come i nomi di `stubs.generated.ts`.
- **Rotte**: analisi del sorgente col compilatore TypeScript, seguendo le funzioni del livello dati, i metodi di `@stubwise/api-client` (dai sorgenti) e le chiamate dirette del trasporto (`request`, `openStream`, download). Le rotte di un nome sono TRANSITIVE: comprendono le letture di contorno (es. `GET /api/auth/me`, `GET /api/people` per i nomi), non solo la rotta principale dell'azione.
- **Permesso e note**: dal registro vero delle rotte del server (`buildApp` con `onRoute`, come `apps/server/src/auth/route-access.test.ts`): `config.access` (`progetto <permesso>` = sul progetto della risorsa, `member` = basta vederlo; `istanza <permesso>`; `utente` = basta essere dentro), `config.reauth` e i flag del PAT (`browserOnly`, `desktopOnly`, `desktopVault`, `credentialDoor`, `partialReauth`). Alcune rotte della cassaforte rifiutano il PAT DENTRO l'handler (`session_required` in `apps/server/src/routes/vault.ts`, `credentials.ts`): la colonna non lo vede, lo dice il segno 🗝.
- **L/S**: L = solo letture, S = solo scritture, L+S = entrambe. «senza rotta» = integrato ma locale (costanti, iscrizioni a eventi, calcoli sul già letto). «in arrivo» = non integrato: nessuna rotta.
- **Limiti noti**: una rotta accesa nell'adattatore può avere la destinazione dell'app ancora spenta (`INTEGRATED` in `apps/desktop/src/renderer/data/integration.ts`): qui conta che il livello dati la chiami. Le funzioni sincrone «in arrivo» (`notIntegratedSync`) sono spesso controlli locali del prototipo, non azioni sul server. «⚠ non trovata» = il percorso composto dall'adattatore non corrisponde a una rotta registrata (di solito un percorso costruito per concatenazione): va guardato a mano.

## Conteggi per area

| Area | Nomi | Integrati | con scritture | senza rotta | In arrivo | 🔐 reauth | 🗝 cassaforte |
|---|---|---|---|---|---|---|---|
| Amministrazione (`access`, «Chi può farlo?») | 3 | 3 | 0 | 0 | 0 | 0 | 0 |
| Amministrazione (`admin`) | 41 | 37 | 28 | 0 | 4 | 20 | 2 |
| Automations (`automations`) | 58 | 16 | 10 | 2 | 42 | 1 | 0 |
| Avvisi (`alerts`) | 5 | 5 | 4 | 0 | 0 | 0 | 0 |
| Calendario (`calendar`) | 22 | 22 | 14 | 3 | 0 | 0 | 0 |
| Cassaforte (`vault`) | 34 | 27 | 12 | 4 | 7 | 2 | 27 |
| Chat (`chat`) | 54 | 44 | 31 | 2 | 10 | 0 | 1 |
| Claude: conversazioni, run e decisioni | 48 | 46 | 34 | 3 | 2 | 0 | 0 |
| Doc di prodotto (`productDocs`) | 89 | 40 | 26 | 3 | 49 | 0 | 0 |
| Docs dei repository (`docs`) | 18 | 18 | 9 | 3 | 0 | 0 | 0 |
| Drive (`drive`) | 27 | 12 | 7 | 0 | 15 | 0 | 2 |
| Home e filtri salvati | 14 | 14 | 8 | 0 | 0 | 0 | 0 |
| Impostazioni di progetto (`projectSettings`) | 59 | 15 | 7 | 0 | 44 | 3 | 0 |
| Istanza (`instance`) | 84 | 59 | 37 | 1 | 25 | 12 | 1 |
| Notifiche e ricerca | 3 | 3 | 2 | 0 | 0 | 0 | 1 |
| Persone e attività | 6 | 6 | 2 | 0 | 0 | 1 | 0 |
| Posta (`mail`) | 45 | 41 | 20 | 5 | 4 | 1 | 2 |
| Progetti e panoramica | 15 | 15 | 5 | 1 | 0 | 0 | 0 |
| Registro delle modifiche (`changelog`) | 5 | 3 | 0 | 0 | 2 | 0 | 0 |
| Richieste | 12 | 12 | 8 | 0 | 0 | 0 | 0 |
| Rilasci e PR (`releases`) | 24 | 20 | 17 | 0 | 4 | 0 | 0 |
| Server (`servers`) | 34 | 27 | 18 | 0 | 7 | 0 | 0 |
| Sessione e account | 49 | 40 | 32 | 1 | 9 | 11 | 2 |
| Support (`support`) | 16 | 12 | 7 | 0 | 4 | 1 | 0 |
| Task | 37 | 37 | 24 | 1 | 0 | 0 | 1 |
| Non integrate (stub generati, fuori dai namespace) | 57 | 1 | 0 | 1 | 56 | 0 | 0 |
| **Totale** | **859** | **575** | **362** | **30** | **284** | **52** | **39** |

Rotte distinte del server chiamate dall'app: **524** su 695 registrate sotto `/api`.

## Le azioni, area per area

### Amministrazione (`access`, «Chi può farlo?»)

3 nomi: 3 integrati (0 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `access.whatCan` | L | `GET /api/access/what-can`<br>`GET /api/agent-sessions`<br>`GET /api/departments`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member` |  |
| `access.whoCan` | L | `GET /api/access/who-can`<br>`GET /api/agent-sessions`<br>`GET /api/departments`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member` |  |
| `access.whoCanChoices` | L | `GET /api/agent-sessions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>utente<br>progetto `member` |  |

### Amministrazione (`admin`)

41 nomi: 37 integrati (28 con scritture, 0 senza rotta: locali o derivati), 4 in arrivo, 20 con reauth, 2 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `admin.DEPARTMENT_COLORS` | in arrivo | — | — |  |
| `admin.addMember` | S | `PUT /api/projects/:projectId/members/:userId` | progetto `project.members.manage` | 🔐 reauth |
| `admin.changeEmail` | S | `PATCH /api/users/:id/email` | istanza `users.manage` | 🔐 reauth |
| `admin.createDepartment` | S | `POST /api/departments` | istanza `departments.manage` |  |
| `admin.createInvite` | S | `POST /api/auth/invites` | istanza `users.invite` | ponte del main: `instance.get`; 🔐 reauth |
| `admin.createPasswordResetLink` | S | `POST /api/users/:id/password-reset` | istanza `users.manage` | ponte del main: `instance.get`; 🔐 reauth |
| `admin.createRole` | L+S | `GET /api/admin/roles`<br>`POST /api/roles` | utente<br>istanza `roles.manage` | 🔐 reauth |
| `admin.deactivatePerson` | S | `POST /api/users/:id/deactivate` | istanza `users.manage` | 🔐 reauth |
| `admin.deleteDepartment` | L+S | `DELETE /api/departments/:id`<br>`GET /api/tasks` | istanza `departments.manage`<br>utente |  |
| `admin.deleteRole` | S | `DELETE /api/roles/:id` | istanza `roles.manage` | 🔐 reauth |
| `admin.duplicateRole` | S | `POST /api/roles/:id/duplicate` | istanza `roles.manage` | 🔐 reauth |
| `admin.getInviteChoices` | L | `GET /api/admin/invite-choices` | istanza `users.invite` |  |
| `admin.getPerson` | L | `GET /api/admin/people/:id` | utente |  |
| `admin.grantMemberPermission` | L+S | `GET /api/projects/:projectId/members/view`<br>`PUT /api/projects/:projectId/members/:userId` | progetto `member`<br>progetto `project.members.manage` | 🔐 reauth |
| `admin.linkGitIdentity` | S | `POST /api/users/:id/git-identities` | istanza `users.manage` | 🔐 reauth |
| `admin.listDepartments` | L | `GET /api/departments`<br>`GET /api/departments/roles`<br>`GET /api/people` | utente<br>utente<br>utente |  |
| `admin.listInvites` | L | `GET /api/admin/invites` | istanza `users.invite` |  |
| `admin.listObservedAuthors` | L | `GET /api/git/observed-authors` | istanza `users.manage` |  |
| `admin.listPeople` | L | `GET /api/admin/people` | utente |  |
| `admin.listProjectMembers` | L | `GET /api/projects/:projectId/members/view` | progetto `member` |  |
| `admin.listRoles` | L | `GET /api/admin/roles` | utente |  |
| `admin.listSecurityEvents` | L | `GET /api/users/:id/security-events` | istanza `users.manage` |  |
| `admin.previewDepartment` | S | `POST /api/departments/:id/preview` | istanza `departments.manage` |  |
| `admin.previewMember` | S | `POST /api/projects/:projectId/members/:userId/preview` | progetto `project.members.manage` |  |
| `admin.reactivatePerson` | S | `POST /api/users/:id/reactivate` | istanza `users.manage` | 🔐 reauth |
| `admin.removeMember` | S | `DELETE /api/projects/:projectId/members/:userId` | progetto `project.members.manage` | 🔐 reauth |
| `admin.resetSecondFactor` | S | `DELETE /api/users/:id/second-factor` | istanza `users.manage` | 🔐 reauth |
| `admin.revokeInvite` | S | `DELETE /api/admin/invites/:id` | istanza `users.invite` |  |
| `admin.revokeMemberPermission` | L+S | `GET /api/projects/:projectId/members/view`<br>`PUT /api/projects/:projectId/members/:userId` | progetto `member`<br>progetto `project.members.manage` | 🔐 reauth |
| `admin.saveDepartment` | L+S | `DELETE /api/servers/:id`<br>`GET /api/departments/roles`<br>`PATCH /api/departments/:id`<br>`PUT /api/departments/:id/roles` | istanza `monitor.manage`<br>utente<br>istanza `departments.manage`<br>istanza `departments.manage` | reauth parziale |
| `admin.saveMember` | S | `PUT /api/projects/:projectId/members/:userId` | progetto `project.members.manage` | 🔐 reauth |
| `admin.setBitbucketUsername` | S | `DELETE /api/users/:id/bitbucket`<br>`PUT /api/users/:id/bitbucket` | istanza `users.manage`<br>istanza `users.manage` | 🔐 reauth |
| `admin.setDepartmentMembers` | in arrivo | — | — |  |
| `admin.setDepartmentPermissions` | in arrivo | — | — |  |
| `admin.setHomeManagers` | in arrivo | — | — |  |
| `admin.setInstanceRole` | S | `PATCH /api/users/:id/instance-role` | istanza `users.manage` | 🔐 reauth |
| `admin.setMemberRole` | S | `PUT /api/projects/:projectId/members/:userId` | progetto `project.members.manage` | 🔐 reauth |
| `admin.unlinkGitIdentity` | S | `DELETE /api/users/:id/git-identities/:email` | istanza `users.manage` | 🔐 reauth |
| `admin.updateDepartment` | S | `PATCH /api/departments/:id` | istanza `departments.manage` | reauth parziale |
| `admin.updateRole` | S | `PATCH /api/roles/:id` | istanza `roles.manage` | 🔐 reauth |
| `admin.viewerLosesIf` | S | `POST /api/roles/:id/viewer-loses` | istanza `roles.manage` |  |

### Automations (`automations`)

58 nomi: 16 integrati (10 con scritture, 2 senza rotta: locali o derivati), 42 in arrivo, 1 con reauth.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `automations.MAX_ACTIVE_RUNS` | in arrivo | — | — |  |
| `automations.SimulationConfigError` | senza rotta | — | — |  |
| `automations.activate` | in arrivo | — | — |  |
| `automations.advanceTime` | in arrivo | — | — |  |
| `automations.approve` | in arrivo | — | — |  |
| `automations.automationOrigin` | in arrivo | — | — |  |
| `automations.canManageAutomation` | in arrivo | — | — |  |
| `automations.canManageAutomations` | in arrivo | — | — |  |
| `automations.canSeeAutomation` | in arrivo | — | — |  |
| `automations.cancelRun` | in arrivo | — | — |  |
| `automations.checkDraft` | in arrivo | — | — |  |
| `automations.chooseProject` | in arrivo | — | — |  |
| `automations.confirmSimulationCost` | in arrivo | — | — |  |
| `automations.connectSource` | in arrivo | — | — |  |
| `automations.createAutomation` | in arrivo | — | — |  |
| `automations.createWebhookSource` | S | `POST /api/automation-sources`<br>`POST /api/settings/webhooks` | istanza `integrations.manage`<br>istanza `integrations.manage` | 🔐 reauth |
| `automations.deleteDraft` | in arrivo | — | — |  |
| `automations.disconnectSource` | in arrivo | — | — |  |
| `automations.duplicateAutomation` | in arrivo | — | — |  |
| `automations.endSimulation` | in arrivo | — | — |  |
| `automations.findRun` | in arrivo | — | — |  |
| `automations.getAutomation` | in arrivo | — | — |  |
| `automations.getProjectAutomations` | in arrivo | — | — |  |
| `automations.getRun` | in arrivo | — | — |  |
| `automations.getSimulation` | in arrivo | — | — |  |
| `automations.listAutomations` | in arrivo | — | — |  |
| `automations.listClientLinks` | L | `GET /api/client-links` | utente |  |
| `automations.listClientSuggestions` | L | `GET /api/client-links/suggestions` | istanza `integrations.manage` |  |
| `automations.listMyApprovals` | in arrivo | — | — |  |
| `automations.listMyRuns` | in arrivo | — | — |  |
| `automations.listRuns` | in arrivo | — | — |  |
| `automations.listSimulationExamples` | in arrivo | — | — |  |
| `automations.listSourceEvents` | L | `GET /api/automation-sources/:id/events` | istanza `integrations.manage` |  |
| `automations.listSources` | L | `GET /api/automation-sources` | utente |  |
| `automations.onAutomationsSettled` | senza rotta | — | — |  |
| `automations.pause` | in arrivo | — | — |  |
| `automations.previewWebhookExample` | S | `POST /api/automation-sources/:id/example/preview` | istanza `integrations.manage` |  |
| `automations.publish` | in arrivo | — | — |  |
| `automations.regenerateWebhookAddress` | S | `POST /api/automation-sources/:id/regenerate` | istanza `integrations.manage` |  |
| `automations.reject` | in arrivo | — | — |  |
| `automations.removeClientLink` | S | `DELETE /api/client-links/:key` | istanza `integrations.manage` |  |
| `automations.renameAutomation` | in arrivo | — | — |  |
| `automations.renameSource` | S | `PATCH /api/automation-sources/:id` | istanza `integrations.manage` |  |
| `automations.retryStep` | in arrivo | — | — |  |
| `automations.runDueSchedules` | in arrivo | — | — |  |
| `automations.saveDraft` | L+S | `DELETE /api/servers/:id`<br>`GET /api/automations/:code/examples` | istanza `monitor.manage`<br>utente |  |
| `automations.searchAutomations` | L+S | `DELETE /api/servers/:id`<br>`GET /api/search` | istanza `monitor.manage`<br>utente |  |
| `automations.setClientLink` | S | `PUT /api/client-links/:key` | istanza `integrations.manage` |  |
| `automations.setWebhookExample` | S | `PUT /api/automation-sources/:id/example` | istanza `integrations.manage` |  |
| `automations.setWebhookLimits` | in arrivo | — | — |  |
| `automations.simulateSourceEvent` | in arrivo | — | — |  |
| `automations.simulationStep` | in arrivo | — | — |  |
| `automations.skipStep` | in arrivo | — | — |  |
| `automations.startManual` | in arrivo | — | — |  |
| `automations.startSimulation` | in arrivo | — | — |  |
| `automations.updateWebhookField` | S | `PATCH /api/automation-sources/:id/fields/:key` | istanza `integrations.manage` |  |
| `automations.validateAutomationFlow` | in arrivo | — | — |  |
| `automations.whenAutomationsIdle` | in arrivo | — | — |  |

### Avvisi (`alerts`)

5 nomi: 5 integrati (4 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `alerts.copySubscriptions` | S | `DELETE /api/me/alert-subscriptions/:projectId/:type`<br>`POST /api/me/alert-subscriptions/:projectId/copy`<br>`PUT /api/me/alert-subscriptions/:projectId/:type` | utente<br>utente<br>utente |  |
| `alerts.muteFromNotification` | S | `DELETE /api/me/alert-subscriptions/:projectId/:type`<br>`POST /api/inbox/:id/mute-type`<br>`PUT /api/me/alert-subscriptions/:projectId/:type` | utente<br>utente<br>utente |  |
| `alerts.muteProject` | S | `DELETE /api/me/alert-subscriptions/:projectId/:type`<br>`POST /api/me/alert-subscriptions/:projectId/mute`<br>`PUT /api/me/alert-subscriptions/:projectId/:type` | utente<br>utente<br>utente |  |
| `alerts.setSubscription` | S | `PUT /api/me/alert-subscriptions/:projectId/:type` | utente |  |
| `alerts.subscriptionRows` | L | `GET /api/me/alert-subscriptions`<br>`GET /api/me/follows` | utente<br>utente |  |

### Calendario (`calendar`)

22 nomi: 22 integrati (14 con scritture, 3 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `calendar.calendarWindow` | senza rotta | — | — |  |
| `calendar.configureSeries` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/series`<br>`PUT /api/me/calendar/series/:recurringEventId` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.createEvent` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts`<br>`POST /api/me/calendar/events` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.deleteEvent` | L+S | `DELETE /api/me/calendar/events/:id`<br>`DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id` | utente<br>istanza `monitor.manage`<br>utente |  |
| `calendar.findFirstFreeSlot` | L | `GET /api/me/calendar/freebusy` | utente |  |
| `calendar.freeBusy` | L | `GET /api/me/calendar/freebusy` | utente |  |
| `calendar.getEvent` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id`<br>`GET /api/me/calendar/series` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.getMeetingPrep` | L | `GET /api/agent-sessions`<br>`GET /api/decisions`<br>`GET /api/me/calendar/events/:id/summary`<br>`GET /api/me/calendar/events/:id/tasks`<br>`GET /api/me/claude-decisions`<br>`GET /api/milestones`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/projects/:projectId/statuses`<br>`GET /api/projects/pulses`<br>`GET /api/requests/to-convert`<br>`GET /api/tasks`<br>`GET /api/tasks/stalled` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>utente<br>utente<br>utente |  |
| `calendar.listCalendars` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts` | istanza `monitor.manage`<br>utente |  |
| `calendar.listEvents` | L | `GET /api/me/calendar/range` | utente |  |
| `calendar.listSeries` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/series` | istanza `monitor.manage`<br>utente |  |
| `calendar.listUpcomingEvents` | L | `GET /api/me/calendar/range` | utente |  |
| `calendar.moveEvent` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id`<br>`POST /api/me/calendar/events/:id/move` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.onSaving` | S | `DELETE /api/servers/:id` | istanza `monitor.manage` |  |
| `calendar.respond` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id`<br>`POST /api/me/calendar/events/:id/respond` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.retrySave` | S | `DELETE /api/servers/:id` | istanza `monitor.manage` |  |
| `calendar.revertEvent` | S | `DELETE /api/servers/:id` | istanza `monitor.manage` |  |
| `calendar.setEventProject` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id`<br>`PUT /api/me/calendar/events/:id/project` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.spanOf` | senza rotta | — | — |  |
| `calendar.syncCalendar` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts`<br>`POST /api/me/google/accounts/:id/sync` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.updateEvent` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/calendar/events/:id`<br>`PATCH /api/me/calendar/events/:id` | istanza `monitor.manage`<br>utente<br>utente |  |
| `calendar.whenCalendarIdle` | senza rotta | — | — |  |

### Cassaforte (`vault`)

34 nomi: 27 integrati (12 con scritture, 4 senza rotta: locali o derivati), 7 in arrivo, 2 con reauth, 27 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `vault.CLIPBOARD_CLEAR_MS` | in arrivo | — | — |  |
| `vault.cancelPairing` | senza rotta | — | — | ponte del main: `vault.pairCancel` |
| `vault.confirm` | S | `POST /api/vault/pending/:personKeyId/confirm` | utente | cassaforte desktop; ponte del main: `vault.confirm`; 🗝 cassaforte |
| `vault.copy` | S | `POST /api/credentials/:id/reveal`<br>`POST /api/vault/actor-challenge` | utente<br>utente | cassaforte desktop; ponte del main: `vault.copy`; 🗝 cassaforte; 🗝 decifra |
| `vault.createCredential` | S | `POST /api/projects/:projectId/credentials` | progetto `credentials.create` | ponte del main: `vault.create`; 🗝 cassaforte |
| `vault.deleteCredential` | S | `DELETE /api/credentials/:id` | progetto `member` | 🗝 cassaforte |
| `vault.finishPairing` | in arrivo | — | — |  |
| `vault.forgetThisMac` | S | `DELETE /api/vault/device-seals/mine` | utente | ponte del main: `vault.forget`; solo PAT desktop; 🗝 cassaforte |
| `vault.getCredential` | L | `GET /api/auth/me`<br>`GET /api/projects/:projectId/credentials`<br>`GET /api/vault/credentials` | utente<br>progetto `member`<br>utente | ponte del main: `vault.mine`; 🗝 cassaforte |
| `vault.getCredentialsEntry` | L | `GET /api/auth/me`<br>`GET /api/people`<br>`GET /api/projects/:projectId/credentials`<br>`GET /api/vault/pending` | utente<br>utente<br>progetto `member`<br>utente | cassaforte desktop; ponte del main: `vault.pending`; 🗝 cassaforte |
| `vault.getVaultEntry` | L | `GET /api/auth/me`<br>`GET /api/people`<br>`GET /api/vault/credentials`<br>`GET /api/vault/pending` | utente<br>utente<br>utente<br>utente | cassaforte desktop; ponte del main: `vault.mine`, `vault.pending`; 🗝 cassaforte |
| `vault.getVaultSimulation` | in arrivo | — | — |  |
| `vault.getVaultStatus` | L | `GET /api/vault/status` | utente | ponte del main: `vault.serverStatus`, `vault.status`; 🗝 cassaforte |
| `vault.listAccessLog` | L | `GET /api/people`<br>`GET /api/projects/:projectId/credentials/log` | utente<br>progetto `member` | 🗝 cassaforte |
| `vault.listCredentials` | L | `GET /api/projects/:projectId/credentials`<br>`GET /api/vault/credentials` | progetto `member`<br>utente | ponte del main: `vault.mine`; 🗝 cassaforte |
| `vault.listMacsOf` | in arrivo | — | — |  |
| `vault.listMyMacs` | L | `GET /api/vault/device-seals` | utente | cassaforte desktop; ponte del main: `vault.macs`; 🗝 cassaforte |
| `vault.listPending` | L | `GET /api/people`<br>`GET /api/vault/pending` | utente<br>utente | cassaforte desktop; ponte del main: `vault.pending`; 🗝 cassaforte |
| `vault.listReaders` | L | `GET /api/auth/me`<br>`GET /api/credentials/:id/readers`<br>`GET /api/people`<br>`GET /api/projects/:projectId/credentials`<br>`GET /api/vault/credentials` | utente<br>utente<br>utente<br>progetto `member`<br>utente | cassaforte desktop; ponte del main: `vault.mine`; 🗝 cassaforte |
| `vault.listShareTargets` | L | `GET /api/auth/me`<br>`GET /api/credentials/:id/readers`<br>`GET /api/people`<br>`GET /api/projects/:projectId/credentials`<br>`GET /api/projects/:projectId/members`<br>`GET /api/vault/credentials` | utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente | cassaforte desktop; ponte del main: `vault.mine`; 🗝 cassaforte |
| `vault.lock` | senza rotta | — | — | ponte del main: `vault.lock` |
| `vault.reject` | S | `POST /api/vault/pending/:personKeyId/reject` | utente | cassaforte desktop; ponte del main: `vault.reject`; 🗝 cassaforte |
| `vault.removeMac` | S | `DELETE /api/vault/device-seals/:id` | utente | cassaforte desktop; ponte del main: `vault.removeMac`; 🔐 reauth; 🗝 cassaforte |
| `vault.removeMacOf` | in arrivo | — | — |  |
| `vault.removeReader` | S | `DELETE /api/credentials/:id/readers/:readerId` | utente | cassaforte desktop; ponte del main: `vault.removeReader`; 🗝 cassaforte |
| `vault.setVaultClipboard` | in arrivo | — | — |  |
| `vault.setVaultSimulation` | in arrivo | — | — |  |
| `vault.share` | L+S | `GET /api/credentials/:id/readers/preview`<br>`POST /api/credentials/:id/readers` | utente<br>utente | cassaforte desktop; ponte del main: `vault.share`; 🗝 cassaforte |
| `vault.show` | S | `POST /api/credentials/:id/reveal`<br>`POST /api/vault/actor-challenge` | utente<br>utente | cassaforte desktop; ponte del main: `vault.show`; 🗝 cassaforte; 🗝 decifra |
| `vault.startPairing` | S | `POST /api/vault/device-pairings` | utente | ponte del main: `vault.pairStart`; solo PAT desktop; 🔐 reauth; 🗝 cassaforte |
| `vault.subscribePairing` | senza rotta | — | — | ponte del main: `vault.onPaired` |
| `vault.subscribeVaultChanges` | senza rotta | — | — | ponte del main: `vault.onChanged` |
| `vault.unlock` | L | `GET /api/vault/device-seals/mine` | utente | ponte del main: `vault.unlock`; solo PAT desktop; 🗝 cassaforte |
| `vault.updateCredential` | S | `PATCH /api/credentials/:id`<br>`PUT /api/credentials/:id/password` | progetto `member`<br>progetto `member` | ponte del main: `vault.setPassword`; 🗝 cassaforte |

### Chat (`chat`)

54 nomi: 44 integrati (31 con scritture, 2 senza rotta: locali o derivati), 10 in arrivo, 1 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `chat.CHAT_EVENT_KINDS` | in arrivo | — | — |  |
| `chat.DM_MAX_PEOPLE` | in arrivo | — | — |  |
| `chat.answerChatClaudeQuestion` | S | `POST /api/chat/messages/:id/claude/answer` | utente |  |
| `chat.archiveChannel` | L+S | `GET /api/projects/archived`<br>`PATCH /api/chat/channels/:id` | utente<br>utente |  |
| `chat.callText` | in arrivo | — | — |  |
| `chat.cancelChatProposal` | L+S | `GET /api/chat/channels/:id`<br>`GET /api/projects/archived`<br>`POST /api/claude/proposals/:id/cancel` | utente<br>utente<br>utente |  |
| `chat.channelStream` | senza rotta | — | — |  |
| `chat.completeEditedChatProposal` | in arrivo | — | — |  |
| `chat.confirmChatProposal` | L+S | `GET /api/chat/channels/:id`<br>`GET /api/projects/archived`<br>`POST /api/claude/proposals/:id/confirm` | utente<br>utente<br>utente | reauth parziale |
| `chat.createChannel` | L+S | `GET /api/projects/archived`<br>`POST /api/chat/channels` | utente<br>utente |  |
| `chat.createRequestFromMessage` | L+S | `GET /api/requests/jobs/:jobId`<br>`POST /api/requests` | progetto `member`<br>progetto `backlog.create` |  |
| `chat.createTaskFromMessage` | L+S | `GET /api/requests/:id`<br>`POST /api/tasks` | progetto `member`<br>progetto `tickets.create` |  |
| `chat.deleteChannel` | S | `DELETE /api/chat/channels/:id` | utente |  |
| `chat.deleteMessage` | S | `DELETE /api/chat/messages/:id` | utente |  |
| `chat.dismissQuestion` | S | `POST /api/chat/questions/:id/dismiss` | utente |  |
| `chat.downloadAttachment` | L | `GET /api/chat/attachments/:id/download` | utente | ponte del main: `api.download` |
| `chat.editChatProposal` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/chat/messages/:id`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>utente<br>progetto `member` |  |
| `chat.editMessage` | L+S | `GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`PATCH /api/chat/messages/:id` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.getChannel` | L | `GET /api/chat/channels/:id`<br>`GET /api/projects/archived` | utente<br>utente |  |
| `chat.getMessage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/chat/messages/:id`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>utente<br>progetto `member` |  |
| `chat.hasNews` | L | `GET /api/chat/signal` | utente |  |
| `chat.inviteMembers` | L+S | `GET /api/projects/archived`<br>`POST /api/chat/channels/:id/members` | utente<br>utente |  |
| `chat.joinChannel` | L+S | `GET /api/projects/archived`<br>`POST /api/chat/channels/:id/join` | utente<br>utente |  |
| `chat.leaveChannel` | S | `DELETE /api/chat/channels/:id/join` | utente |  |
| `chat.listChannelMembers` | L | `GET /api/chat/channels/:id` | utente |  |
| `chat.listChannels` | L | `GET /api/chat/channels`<br>`GET /api/projects/archived` | utente<br>utente |  |
| `chat.listClaudeQuestions` | L | `GET /api/agent-sessions`<br>`GET /api/chat/channels`<br>`GET /api/chat/claude-questions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/projects/archived` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente |  |
| `chat.listMentions` | L | `GET /api/chat/mentions`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.listMessages` | L | `GET /api/chat/channels/:id/messages`<br>`GET /api/chat/channels/:id`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.listQuestions` | L | `GET /api/agent-sessions`<br>`GET /api/chat/channels`<br>`GET /api/chat/questions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/projects/archived` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente |  |
| `chat.listThread` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/chat/messages/:id/thread`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>utente<br>progetto `member` |  |
| `chat.listThreadsWithNews` | L | `GET /api/chat/threads`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.markRead` | S | `POST /api/chat/channels/:id/read` | utente |  |
| `chat.markThreadRead` | L+S | `GET /api/chat/messages/:id`<br>`POST /api/chat/channels/:id/read` | utente<br>utente |  |
| `chat.normalizeChannelName` | in arrivo | — | — |  |
| `chat.onChatChange` | S | `DELETE /api/servers/:id` | istanza `monitor.manage` |  |
| `chat.openDm` | L+S | `GET /api/projects/archived`<br>`POST /api/chat/dm` | utente<br>utente |  |
| `chat.publishChatEvent` | in arrivo | — | — |  |
| `chat.publishReleasePage` | in arrivo | — | — |  |
| `chat.publishWeeklyBrief` | in arrivo | — | — |  |
| `chat.recordPullRequestEvent` | in arrivo | — | — |  |
| `chat.removeMember` | L+S | `DELETE /api/chat/channels/:id/members/:userId`<br>`GET /api/projects/archived` | utente<br>utente |  |
| `chat.retryClaudeReply` | L+S | `GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`POST /api/chat/messages/:id/claude/retry` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.searchChat` | L | `GET /api/chat/search`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.sendMessage` | L+S | `DELETE /api/chat/attachments/:id`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`POST /api/chat/channels/:id/attachments`<br>`POST /api/chat/channels/:id/messages` | utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.setNotifyLevel` | S | `PUT /api/chat/channels/:id/pref` | utente |  |
| `chat.setPublishedEvents` | L+S | `GET /api/projects/archived`<br>`PUT /api/chat/channels/:id/events` | utente<br>utente |  |
| `chat.setThreadFollow` | S | `PUT /api/chat/messages/:id/follow` | utente |  |
| `chat.stopClaudeReply` | L+S | `GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`POST /api/chat/messages/:id/claude/stop` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.subscribeChat` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/chat/channels/:id/messages`<br>`GET /api/chat/messages/:id`<br>`GET /api/chat/messages/:id/thread`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>utente<br>progetto `member` |  |
| `chat.threadStream` | senza rotta | — | — |  |
| `chat.toggleReaction` | L+S | `GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`POST /api/chat/messages/:id/reactions/toggle` | utente<br>utente<br>utente<br>utente<br>utente |  |
| `chat.updateChannel` | L+S | `GET /api/projects/archived`<br>`PATCH /api/chat/channels/:id` | utente<br>utente |  |
| `chat.whenClaudeIdle` | in arrivo | — | — |  |

### Claude: conversazioni, run e decisioni

48 nomi: 46 integrati (34 con scritture, 3 senza rotta: locali o derivati), 2 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `answerQuestion` | L+S | `GET /api/agent-sessions/:id`<br>`POST /api/claude/conversations/:id/questions/:questionId/answer`<br>`POST /api/tickets/:id/questions/answer` | utente<br>utente<br>progetto `member` |  |
| `archiveConversation` | L+S | `GET /api/projects/archived`<br>`PATCH /api/claude/conversations/:id` | utente<br>utente |  |
| `cancelProposal` | S | `POST /api/claude/proposals/:id/cancel` | utente |  |
| `cancelRun` | S | `POST /api/tasks/:ticketId/cancel-run` | progetto `runs.start` |  |
| `claude.declaredClassOf` | in arrivo | — | — |  |
| `claude.isCatalogFn` | in arrivo | — | — |  |
| `claude.retryClaudeEffect` | S | `POST /api/claude/groups/:id/actions/:index/retry` | utente |  |
| `claude.undoClaudeActions` | L+S | `GET /api/claude/conversations/:id/groups`<br>`GET /api/people`<br>`POST /api/claude/groups/:id/undo` | utente<br>utente<br>utente |  |
| `closeRefine` | L+S | `DELETE /api/backlog/:id/refine-session`<br>`GET /api/agent-sessions/:id` | progetto `backlog.edit`<br>utente |  |
| `confirmProposal` | S | `POST /api/claude/proposals/:id/confirm` | utente | reauth parziale |
| `contextIdOf` | L | `GET /api/automations`<br>`GET /api/claude/conversations`<br>`GET /api/support/conversations/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>utente |  |
| `continueConversation` | L+S | `GET /api/projects/archived`<br>`POST /api/claude/conversations/:id/continue` | utente<br>utente |  |
| `createConversation` | L+S | `GET /api/projects/archived`<br>`POST /api/claude/conversations` | utente<br>utente |  |
| `decidePlan` | L+S | `GET /api/agent-sessions/:id`<br>`POST /api/tickets/:id/approve-plan`<br>`POST /api/tickets/:id/reject-plan` | utente<br>progetto `plans.approve`<br>progetto `plans.approve` |  |
| `deleteConversation` | S | `DELETE /api/claude/conversations/:id` | utente |  |
| `describeContext` | L | `GET /api/agent-sessions`<br>`GET /api/automations`<br>`GET /api/claude/conversations`<br>`GET /api/me/mail/threads/:threadId`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/:id`<br>`GET /api/support/conversations/by-code/:code`<br>`GET /api/tickets/:id` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>progetto `member` |  |
| `dismissClaudeSuggestion` | S | `POST /api/claude/suggestions/dismiss` | utente |  |
| `editProposal` | L | `GET /api/claude/conversations/:id/proposals` | utente |  |
| `getClaudeSuggestion` | L | `GET /api/claude/suggestions` | utente |  |
| `getConversation` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/auth/me`<br>`GET /api/automations`<br>`GET /api/automations/:code`<br>`GET /api/automations/:code/examples`<br>`GET /api/automations/:code/test/client-project`<br>`GET /api/claude/conversations`<br>`GET /api/claude/conversations/:id`<br>`GET /api/claude/conversations/:id/groups`<br>`GET /api/claude/conversations/:id/proposals`<br>`GET /api/claude/conversations/:id/questions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/projects/archived`<br>`GET /api/requests/:id`<br>`GET /api/requests/by-code/:code`<br>`GET /api/support/conversations/by-code/:code`<br>`GET /api/tasks/:ticketId/work`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id`<br>`POST /api/automations/:code/test/claude`<br>`POST /api/automations/:code/test/estimate`<br>`POST /api/automations/:code/tested` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>progetto `member`<br>utente<br>utente<br>progetto `member`<br>utente<br>progetto `member`<br>utente<br>utente<br>utente |  |
| `getRefineOf` | L | `GET /api/agent-sessions`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>progetto `member` |  |
| `getTaskWork` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions/:id`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/tasks/:ticketId/work` | istanza `monitor.manage`<br>utente<br>utente<br>progetto `member` |  |
| `listClaudeDecisions` | L | `GET /api/me/claude-decisions`<br>`GET /api/me/product-questions` | utente<br>utente |  |
| `listCommands` | L | `GET /api/projects/:projectId/plugins` | progetto `member` |  |
| `listConversations` | L+S | `GET /api/agent-sessions`<br>`GET /api/claude/conversations`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/projects/archived`<br>`POST /api/tasks/:ticketId/server-fix` | utente<br>utente<br>utente<br>progetto `member`<br>utente<br>progetto `servers.operate` |  |
| `mergeStreamEvent` | senza rotta | — | — |  |
| `onConversationChange` | S | `DELETE /api/servers/:id` | istanza `monitor.manage` |  |
| `preApprovePlan` | L+S | `GET /api/agent-sessions/:id`<br>`POST /api/tickets/:id/pre-approve-plan` | utente<br>progetto `plans.approve` |  |
| `reconnectDelay` | senza rotta | — | — |  |
| `relaunchWithInstructions` | S | `POST /api/tickets/:ticketId/comments`<br>`POST /api/tickets/:id/run-ai` | progetto `tickets.comment`<br>progetto `runs.start` |  |
| `renameConversation` | L+S | `GET /api/projects/archived`<br>`PATCH /api/claude/conversations/:id` | utente<br>utente |  |
| `requestChanges` | L+S | `GET /api/tasks/:ticketId/work`<br>`GET /api/tickets/:id`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections` | progetto `member`<br>progetto `member`<br>progetto `corrections.request` |  |
| `resolveCitations` | L+S | `GET /api/agent-sessions`<br>`GET /api/docs/codes/:code`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code`<br>`POST /api/claude/citations/resolve` | utente<br>utente<br>utente<br>utente<br>progetto `member`<br>utente<br>utente<br>utente |  |
| `resolveCodes` | L | `GET /api/agent-sessions`<br>`GET /api/docs/codes/:code`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/repositories/:repositoryId/docs/pages/:slug`<br>`GET /api/requests/by-code/:code`<br>`GET /api/tasks/by-code/:code` | utente<br>utente<br>utente<br>progetto `member`<br>progetto `docs.view`<br>utente<br>utente |  |
| `resumeCorrection` | L+S | `GET /api/tickets/:id`<br>`POST /api/tickets/:id/run-ai` | progetto `member`<br>progetto `runs.start` |  |
| `revokePlanApproval` | L+S | `DELETE /api/tickets/:id/pre-approve-plan`<br>`GET /api/agent-sessions/:id` | progetto `plans.approve`<br>utente |  |
| `searchMentions` | L | `GET /api/agent-sessions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests`<br>`GET /api/search`<br>`GET /api/tasks` | utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>utente |  |
| `sendMessage` | L+S | `GET /api/agent-sessions`<br>`GET /api/automations`<br>`GET /api/claude/conversations`<br>`GET /api/me/mail/threads/:threadId`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/:id`<br>`GET /api/support/conversations/by-code/:code`<br>`GET /api/tickets/:id`<br>`PATCH /api/claude/conversations/:id`<br>`POST /api/agent-sessions/:id/messages` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>progetto `member`<br>utente<br>utente |  |
| `setConversationContext` | S | `PATCH /api/claude/conversations/:id` | utente |  |
| `setConversationContexts` | L+S | `GET /api/agent-sessions`<br>`GET /api/automations`<br>`GET /api/claude/conversations`<br>`GET /api/me/mail/threads/:threadId`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/requests/:id`<br>`GET /api/support/conversations/by-code/:code`<br>`GET /api/tickets/:id`<br>`PATCH /api/claude/conversations/:id` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>progetto `member`<br>utente |  |
| `setVisibility` | L+S | `GET /api/projects/archived`<br>`POST /api/claude/conversations/:id/visibility` | utente<br>utente |  |
| `settlePageEvent` | S | `DELETE /api/servers/:id`<br>`POST /api/claude/proposals/:id/actions/:index/outcome` | istanza `monitor.manage`<br>utente |  |
| `startRefineConversation` | L+S | `GET /api/agent-sessions`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`POST /api/backlog/:id/refine-session`<br>`POST /api/tasks/:ticketId/server-fix` | utente<br>utente<br>progetto `member`<br>progetto `backlog.edit`<br>progetto `servers.operate` |  |
| `startRun` | S | `POST /api/tickets/:id/run-ai` | progetto `runs.start` |  |
| `stop` | S | `POST /api/agent-sessions/:id/messages` | utente |  |
| `stopAndSend` | S | `POST /api/agent-sessions/:id/messages` | utente |  |
| `subscribe` | L+S | `DELETE /api/servers/:id`<br>`GET /api/agent-sessions`<br>`GET /api/agent-sessions/:id`<br>`GET /api/agent-sessions/:id/events`<br>`GET /api/automations/:code`<br>`GET /api/automations/:code/examples`<br>`GET /api/automations/:code/test/client-project`<br>`GET /api/claude/conversations/:id/groups`<br>`GET /api/claude/conversations/:id/proposals`<br>`GET /api/claude/conversations/:id/questions`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`GET /api/tasks/:ticketId/work`<br>`GET /api/tickets/:id`<br>`POST /api/automations/:code/test/claude`<br>`POST /api/automations/:code/test/estimate`<br>`POST /api/automations/:code/tested` | istanza `monitor.manage`<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>progetto `member`<br>utente<br>utente<br>utente |  |
| `suggestionKeyOf` | senza rotta | — | — |  |

### Doc di prodotto (`productDocs`)

89 nomi: 40 integrati (26 con scritture, 3 senza rotta: locali o derivati), 49 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `productDocs.acceptFirstVersionPage` | S | `POST /api/product-pages/:id/first-version/accept` | progetto `docs.edit` |  |
| `productDocs.acceptFirstVersionPageAs` | in arrivo | — | — |  |
| `productDocs.acceptProductMark` | S | `POST /api/product-marks/:id/looks-good` | progetto `docs.edit` |  |
| `productDocs.acceptProductMarkAs` | in arrivo | — | — |  |
| `productDocs.addProductComment` | S | `POST /api/product-pages/:id/comments` | progetto `docs.edit` |  |
| `productDocs.addProductCommentAs` | in arrivo | — | — |  |
| `productDocs.answerProductQuestion` | S | `POST /api/product-comments/:id/answer` | progetto `docs.edit` |  |
| `productDocs.answerProductQuestionAs` | in arrivo | — | — |  |
| `productDocs.applyProductSource` | in arrivo | — | — |  |
| `productDocs.askProductQuestion` | in arrivo | — | — |  |
| `productDocs.createProductPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/by-code/:code`<br>`POST /api/projects/:projectId/product/pages` | istanza `monitor.manage`<br>utente<br>progetto `docs.edit` |  |
| `productDocs.createProductPageAs` | in arrivo | — | — |  |
| `productDocs.deleteProductPage` | S | `DELETE /api/product-pages/:id`<br>`DELETE /api/servers/:id` | progetto `docs.edit`<br>istanza `monitor.manage` |  |
| `productDocs.deleteProductPageAs` | in arrivo | — | — |  |
| `productDocs.drawWireframe` | S | `POST /api/product-pages/:id/wireframes` | progetto `docs.edit` |  |
| `productDocs.drawWireframeAs` | in arrivo | — | — |  |
| `productDocs.firstVersionSourcesFor` | in arrivo | — | — |  |
| `productDocs.followProductPage` | S | `DELETE /api/product-pages/:id/follow`<br>`PUT /api/product-pages/:id/follow` | progetto `docs.view`<br>progetto `docs.view` |  |
| `productDocs.followersOf` | in arrivo | — | — |  |
| `productDocs.getProductExport` | L | `GET /api/product-pages/:id/images/:imageId`<br>`GET /api/product-pages/:id/export`<br>`GET /api/projects/:projectId/product/export` | progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view` |  |
| `productDocs.getProductFirstVersion` | L | `GET /api/projects/:projectId/product/first-version` | progetto `docs.view` |  |
| `productDocs.getProductPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/by-code/:code` | istanza `monitor.manage`<br>utente |  |
| `productDocs.getProductPresence` | in arrivo | — | — |  |
| `productDocs.getProductSpace` | L | `GET /api/projects/:projectId/product` | progetto `docs.view` |  |
| `productDocs.joinProductPage` | in arrivo | — | — |  |
| `productDocs.keepWireframe` | S | `POST /api/product-pages/:id/wireframes/:blockId/keep` | progetto `docs.edit` |  |
| `productDocs.keepWireframeAs` | in arrivo | — | — |  |
| `productDocs.lastRevisionTouching` | in arrivo | — | — |  |
| `productDocs.leaveProductPageAs` | in arrivo | — | — |  |
| `productDocs.listFirstVersionSources` | L | `GET /api/projects/:projectId/product/first-version/sources` | progetto `docs.view` |  |
| `productDocs.listOpenProductQuestions` | L | `GET /api/me/product-questions` | utente |  |
| `productDocs.listProductComments` | L | `GET /api/product-pages/:id/comments` | progetto `docs.view` |  |
| `productDocs.listProductLinkedRequests` | L | `GET /api/product-pages/:id/requests` | progetto `docs.view` |  |
| `productDocs.listProductLinkedRequestsAs` | in arrivo | — | — |  |
| `productDocs.listProductMarks` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/:id/marks` | istanza `monitor.manage`<br>progetto `docs.view` |  |
| `productDocs.listProductMarksAs` | in arrivo | — | — |  |
| `productDocs.listProductRequestsPreparing` | senza rotta | — | — |  |
| `productDocs.listProductRevisions` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/:id/revisions` | istanza `monitor.manage`<br>progetto `docs.view` |  |
| `productDocs.moveProductPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/by-code/:code`<br>`PATCH /api/product-pages/:id` | istanza `monitor.manage`<br>utente<br>progetto `docs.edit` |  |
| `productDocs.onAnchorsMerged` | in arrivo | — | — |  |
| `productDocs.onProductFirstVersion` | senza rotta | — | — |  |
| `productDocs.onProductPresence` | in arrivo | — | — |  |
| `productDocs.onProductQuestionsChanged` | senza rotta | — | — |  |
| `productDocs.openProductQuestions` | in arrivo | — | — |  |
| `productDocs.pickWireframe` | in arrivo | — | — |  |
| `productDocs.productDocRecipients` | in arrivo | — | — |  |
| `productDocs.productFirstVersionOf` | in arrivo | — | — |  |
| `productDocs.productImageSrc` | L | `GET /api/product-pages/:id/images/:imageId` | progetto `docs.view` |  |
| `productDocs.productMentionCandidates` | L | `GET /api/projects/:projectId/product/mention-candidates` | progetto `docs.view` |  |
| `productDocs.productOriginOf` | in arrivo | — | — |  |
| `productDocs.productPageByCode` | in arrivo | — | — |  |
| `productDocs.productPageById` | in arrivo | — | — |  |
| `productDocs.productPageRef` | in arrivo | — | — |  |
| `productDocs.productQuestionDecisions` | in arrivo | — | — |  |
| `productDocs.productQuestionRequestDraft` | in arrivo | — | — |  |
| `productDocs.productRequestsPreparingAs` | in arrivo | — | — |  |
| `productDocs.productUpdatesWaiting` | L | `GET /api/projects/:projectId/product` | progetto `docs.view` |  |
| `productDocs.proposeBacklogFromPage` | L | `GET /api/product-pages/:id/backlog-candidates`<br>`GET /api/projects/:projectId/product` | progetto `docs.edit`<br>progetto `docs.view` |  |
| `productDocs.proposeBacklogFromPageAs` | in arrivo | — | — |  |
| `productDocs.readableProductPages` | in arrivo | — | — |  |
| `productDocs.redrawWireframe` | S | `POST /api/product-pages/:id/wireframes/:blockId/redraw` | progetto `docs.edit` |  |
| `productDocs.redrawWireframeAs` | in arrivo | — | — |  |
| `productDocs.renameProductPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/by-code/:code`<br>`PATCH /api/product-pages/:id` | istanza `monitor.manage`<br>utente<br>progetto `docs.edit` |  |
| `productDocs.renameProductPageAs` | in arrivo | — | — |  |
| `productDocs.reopenProductComment` | S | `POST /api/product-comments/:id/reopen` | progetto `docs.edit` |  |
| `productDocs.replaceWireframeWithImage` | S | `POST /api/product-pages/:id/wireframes/:blockId/replace-image` | progetto `docs.edit` |  |
| `productDocs.replaceWireframeWithImageAs` | in arrivo | — | — |  |
| `productDocs.resolveProductComment` | S | `POST /api/product-comments/:id/resolve` | progetto `docs.edit` |  |
| `productDocs.saveProductBlocks` | L+S | `DELETE /api/servers/:id`<br>`GET /api/product-pages/by-code/:code`<br>`POST /api/product-pages/:id/ops` | istanza `monitor.manage`<br>utente<br>progetto `docs.edit` |  |
| `productDocs.searchProductPages` | L+S | `DELETE /api/servers/:id`<br>`GET /api/projects/:projectId/product/search`<br>`GET /api/search` | istanza `monitor.manage`<br>progetto `docs.view`<br>utente |  |
| `productDocs.setProductPresence` | in arrivo | — | — |  |
| `productDocs.startFirstVersion` | S | `POST /api/projects/:projectId/product/first-version` | progetto `docs.edit` |  |
| `productDocs.startFirstVersionAs` | in arrivo | — | — |  |
| `productDocs.stopFirstVersion` | S | `POST /api/projects/:projectId/product/first-version/stop` | progetto `docs.edit` |  |
| `productDocs.stopFirstVersionAs` | in arrivo | — | — |  |
| `productDocs.storeProductImage` | S | `POST /api/product-pages/:id/images` | progetto `docs.edit` |  |
| `productDocs.subscribeProductPage` | in arrivo | — | — |  |
| `productDocs.touchedAfter` | in arrivo | — | — |  |
| `productDocs.undoFirstVersion` | S | `POST /api/projects/:projectId/product/first-version/undo` | progetto `docs.edit` |  |
| `productDocs.undoFirstVersionAs` | in arrivo | — | — |  |
| `productDocs.undoProductChange` | S | `POST /api/product-marks/:id/undo`<br>`POST /api/product-revisions/:id/undo-all` | progetto `docs.edit`<br>progetto `docs.edit` |  |
| `productDocs.undoProductChangeAs` | in arrivo | — | — |  |
| `productDocs.unfollowProductPage` | S | `DELETE /api/product-pages/:id/follow`<br>`PUT /api/product-pages/:id/follow` | progetto `docs.view`<br>progetto `docs.view` |  |
| `productDocs.whenFirstVersionIdle` | in arrivo | — | — |  |
| `productDocs.whenProductClaudeIdle` | in arrivo | — | — |  |
| `productDocs.whenProductIdle` | in arrivo | — | — |  |
| `productDocs.wireframeKey` | in arrivo | — | — |  |
| `productDocs.writeProductBlocksAs` | in arrivo | — | — |  |
| `productDocs.writersNear` | in arrivo | — | — |  |

### Docs dei repository (`docs`)

18 nomi: 18 integrati (9 con scritture, 3 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `docs.DOC_KINDS` | senza rotta | — | — |  |
| `docs.askDocs` | S | `POST /api/projects/:projectId/docs/chat`<br>`POST /api/repositories/:repositoryId/docs/chat` | progetto `docs.view`<br>progetto `docs.view` |  |
| `docs.createManualPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/tree`<br>`POST /api/repositories/:repositoryId/docs/manual` | istanza `monitor.manage`<br>utente<br>progetto `docs.view`<br>progetto `docs.edit` |  |
| `docs.deleteManualPage` | L+S | `DELETE /api/repositories/:repositoryId/docs/manual/:id`<br>`DELETE /api/servers/:id`<br>`GET /api/repositories/:repositoryId/docs/tree` | progetto `docs.edit`<br>istanza `monitor.manage`<br>progetto `docs.view` |  |
| `docs.generationHistory` | senza rotta | — | — |  |
| `docs.getDocPage` | L | `GET /api/auth/me`<br>`GET /api/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/pages/:slug`<br>`GET /api/repositories/:repositoryId/docs/tree` | utente<br>utente<br>progetto `docs.view`<br>progetto `docs.view` |  |
| `docs.getDocSpace` | L | `GET /api/auth/me`<br>`GET /api/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/brief`<br>`GET /api/repositories/:repositoryId/docs/highlights`<br>`GET /api/repositories/:repositoryId/docs/pages/:slug`<br>`GET /api/repositories/:repositoryId/docs/status`<br>`GET /api/repositories/:repositoryId/docs/tree`<br>`GET /api/repositories/:id/graph`<br>`GET /api/repositories/:id/graph/report` | utente<br>utente<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `repos.view`<br>progetto `repos.view` |  |
| `docs.getProjectDocsHome` | L+S | `DELETE /api/servers/:id`<br>`GET /api/auth/me`<br>`GET /api/projects/:projectId/decisions`<br>`GET /api/projects/:projectId/docs/spaces`<br>`GET /api/projects/:projectId/product`<br>`GET /api/repositories/:repositoryId/docs/brief`<br>`GET /api/repositories/:repositoryId/docs/highlights`<br>`GET /api/repositories/:repositoryId/docs/pages/:slug`<br>`GET /api/repositories/:repositoryId/docs/status`<br>`GET /api/repositories/:repositoryId/docs/tree`<br>`GET /api/repositories/:id/graph`<br>`GET /api/repositories/:id/graph/report` | istanza `monitor.manage`<br>utente<br>progetto `member`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `repos.view`<br>progetto `repos.view` |  |
| `docs.getRepoBrief` | L | `GET /api/repositories/:repositoryId/docs/brief` | progetto `docs.view` |  |
| `docs.graphAction` | L+S | `GET /api/docs/spaces`<br>`GET /api/repositories/:id/graph`<br>`GET /api/repositories/:id/graph/report`<br>`PATCH /api/repositories/:slug`<br>`POST /api/repositories/:id/graph/generate`<br>`POST /api/repositories/:id/graph/setup-pr` | utente<br>progetto `repos.view`<br>progetto `repos.view`<br>progetto `repos.manage`<br>progetto `repos.manage`<br>progetto `repos.manage` |  |
| `docs.listDocSpaces` | L | `GET /api/auth/me`<br>`GET /api/projects/:projectId/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/brief`<br>`GET /api/repositories/:repositoryId/docs/highlights`<br>`GET /api/repositories/:repositoryId/docs/pages/:slug`<br>`GET /api/repositories/:repositoryId/docs/status`<br>`GET /api/repositories/:repositoryId/docs/tree`<br>`GET /api/repositories/:id/graph`<br>`GET /api/repositories/:id/graph/report` | utente<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `docs.view`<br>progetto `repos.view`<br>progetto `repos.view` |  |
| `docs.listDocTree` | L | `GET /api/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/tree` | utente<br>progetto `docs.view` |  |
| `docs.recordDocView` | S | `POST /api/repositories/:repositoryId/docs/pages/:slug/view` | progetto `docs.view` |  |
| `docs.resumeGeneration` | L+S | `GET /api/repositories/:repositoryId/docs/status`<br>`POST /api/repositories/:repositoryId/docs/resume` | progetto `docs.view`<br>progetto `docs.generate` |  |
| `docs.searchDocs` | L | `GET /api/agent-sessions`<br>`GET /api/docs/spaces`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/docs/search`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>utente<br>progetto `docs.view`<br>progetto `member` |  |
| `docs.startGeneration` | L+S | `GET /api/repositories/:repositoryId/docs/status`<br>`POST /api/repositories/:repositoryId/docs/generate` | progetto `docs.view`<br>progetto `docs.generate` |  |
| `docs.updateManualPage` | L+S | `DELETE /api/servers/:id`<br>`GET /api/docs/spaces`<br>`GET /api/repositories/:repositoryId/docs/tree`<br>`PATCH /api/repositories/:repositoryId/docs/manual/:id` | istanza `monitor.manage`<br>utente<br>progetto `docs.view`<br>progetto `docs.edit` |  |
| `docs.whenDocsIdle` | senza rotta | — | — |  |

### Drive (`drive`)

27 nomi: 12 integrati (7 con scritture, 0 senza rotta: locali o derivati), 15 in arrivo, 2 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `drive.addGoogleFile` | in arrivo | — | — |  |
| `drive.connectGoogle` | L+S | `GET /api/me/google/accounts`<br>`GET /api/me/google/workspaces`<br>`POST /api/me/google/connect` | utente<br>utente<br>utente |  |
| `drive.countDriveReaders` | in arrivo | — | — |  |
| `drive.deleteDriveFile` | S | `DELETE /api/drive/files/:id` | utente |  |
| `drive.disconnectGoogle` | L+S | `DELETE /api/me/google/accounts/:id`<br>`GET /api/me/google/accounts` | utente<br>utente |  |
| `drive.driveContentHistory` | in arrivo | — | — |  |
| `drive.getDriveFile` | L+S | `DELETE /api/servers/:id`<br>`GET /api/drive/codes/:code`<br>`GET /api/drive/files/:id`<br>`GET /api/projects` | istanza `monitor.manage`<br>utente<br>utente<br>utente |  |
| `drive.getGoogleAccount` | L | `GET /api/me/google/accounts` | utente |  |
| `drive.linkFolder` | in arrivo | — | — |  |
| `drive.listDriveFiles` | L | `GET /api/drive/files`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/drive/files` | utente<br>utente<br>utente |  |
| `drive.listDriveFilesForClaude` | in arrivo | — | — |  |
| `drive.listFolderLinks` | in arrivo | — | — |  |
| `drive.listGoogleFiles` | in arrivo | — | — |  |
| `drive.listGoogleFolders` | in arrivo | — | — |  |
| `drive.listGoogleOutside` | in arrivo | — | — |  |
| `drive.listGoogleWorkspaces` | L | `GET /api/me/google/workspaces` | utente |  |
| `drive.listMyFolderLinks` | in arrivo | — | — |  |
| `drive.recordOpen` | L | `GET /api/drive/files/:id/download`<br>`GET /api/drive/files/:id/open`<br>`GET /api/drive/files/:id/preview`<br>`GET /api/drive/files/:id` | utente<br>utente<br>utente<br>utente | ponte del main: `api.download` |
| `drive.removeGoogleFile` | in arrivo | — | — |  |
| `drive.retryExtraction` | L+S | `GET /api/projects`<br>`POST /api/drive/files/:id/retry` | utente<br>utente |  |
| `drive.saveAttachmentToDrive` | L+S | `GET /api/projects`<br>`POST /api/chat/attachments/:id/save-to-drive` | utente<br>utente |  |
| `drive.searchDrive` | L | `GET /api/drive/files`<br>`GET /api/drive/google/outside`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/drive/files` | utente<br>utente<br>utente<br>utente |  |
| `drive.setHidden` | in arrivo | — | — |  |
| `drive.syncFolder` | in arrivo | — | — |  |
| `drive.unlinkFolder` | in arrivo | — | — |  |
| `drive.uploadFiles` | L+S | `GET /api/projects/:projectId/drive/files`<br>`POST /api/projects/:projectId/drive/files`<br>`GET /api/projects` | utente<br>utente<br>utente | ponte del main: `api.upload` |
| `drive.whenDriveIdle` | in arrivo | — | — |  |

### Home e filtri salvati

14 nomi: 14 integrati (8 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `deleteFilter` | S | `DELETE /api/filters/:id` | utente |  |
| `getPersonalHome` | L | `GET /api/me/home` | utente |  |
| `getSavedFilter` | L | `GET /api/filters/:id` | utente |  |
| `listDepartmentHomes` | L | `GET /api/me/home` | utente |  |
| `listDepartmentRoles` | L | `GET /api/departments/roles` | utente |  |
| `listPinnedFilterIds` | L | `GET /api/me/pinned-filters` | utente |  |
| `listSavedFilters` | L | `GET /api/filters` | utente |  |
| `markDepartmentHomeSeen` | L+S | `GET /api/departments/:departmentId/home`<br>`POST /api/me/home/seen/:departmentId` | utente<br>utente |  |
| `resetPersonalHome` | S | `DELETE /api/me/home` | utente |  |
| `saveFilter` | S | `POST /api/filters` | utente |  |
| `setDepartmentHome` | S | `PUT /api/departments/:departmentId/home` | utente |  |
| `setFilterPinned` | S | `DELETE /api/me/pinned-filters/:id`<br>`PUT /api/me/pinned-filters/:id` | utente<br>utente |  |
| `setPersonalHome` | S | `PUT /api/me/home` | utente |  |
| `updateFilter` | S | `PATCH /api/filters/:id` | utente |  |

### Impostazioni di progetto (`projectSettings`)

59 nomi: 15 integrati (7 con scritture, 0 senza rotta: locali o derivati), 44 in arrivo, 3 con reauth.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `projectSettings.BASE_PLUGIN` | in arrivo | — | — |  |
| `projectSettings.CORRECTION_CAP_MAX` | in arrivo | — | — |  |
| `projectSettings.CORRECTION_CAP_MIN` | in arrivo | — | — |  |
| `projectSettings.DESCRIPTION_MAX` | in arrivo | — | — |  |
| `projectSettings.NAME_MAX` | in arrivo | — | — |  |
| `projectSettings.PROJECT_SWITCHES` | in arrivo | — | — |  |
| `projectSettings.PULSE_DAYS_MAX` | in arrivo | — | — |  |
| `projectSettings.PULSE_DAYS_MIN` | in arrivo | — | — |  |
| `projectSettings.RECOMMENDED_PRESETS` | in arrivo | — | — |  |
| `projectSettings.applyPluginPreset` | in arrivo | — | — |  |
| `projectSettings.archiveProject` | S | `POST /api/projects/:projectId/archive` | progetto `project.settings.manage` |  |
| `projectSettings.busyReasonsOf` | in arrivo | — | — |  |
| `projectSettings.checkRepositoryAccess` | in arrivo | — | — |  |
| `projectSettings.configureRepositoryWebhook` | in arrivo | — | — |  |
| `projectSettings.createEnvFile` | in arrivo | — | — |  |
| `projectSettings.createRepository` | in arrivo | — | — |  |
| `projectSettings.deleteEnvFile` | in arrivo | — | — |  |
| `projectSettings.deleteProject` | S | `DELETE /api/projects/:projectId` | progetto `member` | 🔐 reauth |
| `projectSettings.getArchivePreview` | L | `GET /api/projects/:projectId/archive-preview` | progetto `project.settings.manage` |  |
| `projectSettings.getArchivedProject` | L | `GET /api/projects/:projectId/archived-view`<br>`GET /api/projects/archived` | progetto `member`<br>utente |  |
| `projectSettings.getDeletionPreview` | L | `GET /api/projects/:projectId/deletion-preview` | progetto `member` |  |
| `projectSettings.getIntegration` | L | `GET /api/projects/:projectId`<br>`GET /api/projects/:projectId/integration` | progetto `member`<br>progetto `member` |  |
| `projectSettings.getProjectPlugins` | L | `GET /api/projects/:projectId/plugins` | progetto `member` |  |
| `projectSettings.getProjectSettings` | L | `GET /api/auth/me`<br>`GET /api/projects/:projectId` | utente<br>progetto `member` |  |
| `projectSettings.getProjectSwitches` | L | `GET /api/projects/:projectId` | progetto `member` |  |
| `projectSettings.getProjectUsage` | in arrivo | — | — |  |
| `projectSettings.importEnvFile` | in arrivo | — | — |  |
| `projectSettings.listArchivedProjects` | L | `GET /api/projects/archived` | utente |  |
| `projectSettings.listEnvFiles` | in arrivo | — | — |  |
| `projectSettings.listProjectRepositories` | in arrivo | — | — |  |
| `projectSettings.listRemoteRepositories` | in arrivo | — | — |  |
| `projectSettings.pluginBothChanged` | in arrivo | — | — |  |
| `projectSettings.pluginChangedKeys` | in arrivo | — | — |  |
| `projectSettings.pluginChoosable` | in arrivo | — | — |  |
| `projectSettings.pluginDisabledInput` | in arrivo | — | — |  |
| `projectSettings.pluginEnabledInput` | in arrivo | — | — |  |
| `projectSettings.pluginHookKey` | in arrivo | — | — |  |
| `projectSettings.pluginKey` | in arrivo | — | — |  |
| `projectSettings.pluginOffKeys` | in arrivo | — | — |  |
| `projectSettings.pluginPresetApplied` | in arrivo | — | — |  |
| `projectSettings.pluginSkillKey` | in arrivo | — | — |  |
| `projectSettings.projectSwitchOn` | in arrivo | — | — |  |
| `projectSettings.pulseNeedsBacklogFor` | in arrivo | — | — |  |
| `projectSettings.reconcilePluginDraft` | in arrivo | — | — |  |
| `projectSettings.regenerateIngestionKey` | L+S | `GET /api/projects/:projectId/integration`<br>`POST /api/projects/:projectId/ingestion-key` | progetto `member`<br>progetto `project.settings.manage` | 🔐 reauth |
| `projectSettings.regenerateWebhookSecret` | S | `POST /api/repositories/:slug/webhook-secret` | progetto `repos.manage` | 🔐 reauth |
| `projectSettings.removeEnvVar` | in arrivo | — | — |  |
| `projectSettings.reopenProject` | S | `POST /api/projects/:projectId/reopen` | progetto `project.settings.manage` |  |
| `projectSettings.reviewAccountChoices` | in arrivo | — | — |  |
| `projectSettings.saveProjectAutomations` | L+S | `GET /api/projects/:projectId`<br>`PATCH /api/projects/:projectId` | progetto `member`<br>progetto `project.settings.manage` |  |
| `projectSettings.saveProjectPlugins` | L+S | `DELETE /api/servers/:id`<br>`GET /api/projects/:projectId/plugins`<br>`PUT /api/projects/:projectId/plugins` | istanza `monitor.manage`<br>progetto `member`<br>progetto `project.settings.manage` |  |
| `projectSettings.setDocsModule` | in arrivo | — | — |  |
| `projectSettings.setEnvVar` | in arrivo | — | — |  |
| `projectSettings.setProjectAi` | in arrivo | — | — |  |
| `projectSettings.simulateNextRepositoryCheck` | in arrivo | — | — |  |
| `projectSettings.simulateNextWebhookSetup` | in arrivo | — | — |  |
| `projectSettings.skillsForRun` | in arrivo | — | — |  |
| `projectSettings.updateProjectGeneral` | in arrivo | — | — |  |
| `projectSettings.updateRepository` | in arrivo | — | — |  |

### Istanza (`instance`)

84 nomi: 59 integrati (37 con scritture, 1 senza rotta: locali o derivati), 25 in arrivo, 12 con reauth, 1 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `instance.BACKGROUND_WEEKLY_THRESHOLD` | in arrivo | — | — |  |
| `instance.DEFAULT_MODELS` | in arrivo | — | — |  |
| `instance.GOOGLE_SETUP` | in arrivo | — | — |  |
| `instance.OPERATION_OF_KIND` | in arrivo | — | — |  |
| `instance.PLUGIN_STEP_MS` | in arrivo | — | — |  |
| `instance.QUOTA_NEAR_PCT` | in arrivo | — | — |  |
| `instance.WEBHOOK_EVENTS` | in arrivo | — | — |  |
| `instance.WEBHOOK_LIMIT` | in arrivo | — | — |  |
| `instance.aiBlockFor` | in arrivo | — | — |  |
| `instance.budgetReached` | in arrivo | — | — |  |
| `instance.createGitAccount` | S | `POST /api/git-accounts` | istanza `git_accounts.manage` | 🔐 reauth |
| `instance.createGoogleApp` | S | `POST /api/settings/google-workspaces` | istanza `integrations.manage` | 🔐 reauth |
| `instance.createProvider` | S | `POST /api/ai-providers` | istanza `ai_providers.manage` | 🔐 reauth |
| `instance.createWebhook` | S | `POST /api/settings/webhooks` | istanza `integrations.manage` | 🔐 reauth |
| `instance.deleteDetachedRepository` | S | `DELETE /api/repositories/:id` | utente | 🔐 reauth |
| `instance.deleteGitAccount` | S | `DELETE /api/git-accounts/:id`<br>`DELETE /api/servers/:id` | istanza `git_accounts.manage`<br>istanza `monitor.manage` | 🔐 reauth |
| `instance.deleteGoogleApp` | L+S | `DELETE /api/settings/google-workspaces/:id`<br>`GET /api/settings/google-workspaces` | istanza `integrations.manage`<br>istanza `integrations.manage` | 🔐 reauth |
| `instance.deleteProvider` | S | `DELETE /api/ai-providers/:id` | istanza `ai_providers.manage` | 🔐 reauth |
| `instance.deleteWebhook` | S | `DELETE /api/settings/webhooks/:id` | istanza `integrations.manage` | 🔐 reauth |
| `instance.dropHeld` | in arrivo | — | — |  |
| `instance.getAiBlock` | L | `GET /api/claude/conversations/status`<br>`GET /api/projects/:projectId` | utente<br>progetto `member` |  |
| `instance.getAutomation` | L | `GET /api/settings/automation` | istanza `settings.manage` |  |
| `instance.getBudget` | L | `GET /api/settings/instance` | istanza `settings.manage` |  |
| `instance.getGoogleRedirectUri` | L | `GET /api/settings/google-workspaces` | istanza `integrations.manage` | ponte del main: `instance.get` |
| `instance.getInstanceStatus` | L | `GET /api/instance/status` | istanza `instance.status.view` |  |
| `instance.getNextPluginOutcome` | in arrivo | — | — |  |
| `instance.getPlugin` | L | `GET /api/plugins/:id` | istanza `plugins.manage` |  |
| `instance.getQueuePause` | L | `GET /api/projects/:projectId` | progetto `member` |  |
| `instance.getServerAnalysisSettings` | L | `GET /api/settings/server-analysis` | istanza `settings.manage` |  |
| `instance.getStorage` | L | `GET /api/settings/instance` | istanza `settings.manage` |  |
| `instance.getUploadsAllowed` | L | `GET /api/storage/uploads` | utente |  |
| `instance.getUsage` | L | `GET /api/ai-usage/summary` | utente |  |
| `instance.getWebhook` | L | `GET /api/settings/webhooks` | istanza `integrations.manage` |  |
| `instance.holdJob` | in arrivo | — | — |  |
| `instance.linkRepository` | S | `POST /api/repositories/:id/link` | utente |  |
| `instance.listAllRepositories` | L | `GET /api/projects`<br>`GET /api/repositories:param` ⚠ non trovata | utente<br>— |  |
| `instance.listDetachedRepositories` | L | `GET /api/repositories/detached` | utente |  |
| `instance.listGitAccounts` | L | `GET /api/git-accounts` | istanza `git_accounts.view` |  |
| `instance.listGoogleApps` | L | `GET /api/settings/google-workspaces` | istanza `integrations.manage` |  |
| `instance.listModels` | L | `GET /api/settings/models` | istanza `settings.manage` |  |
| `instance.listPlugins` | L | `GET /api/plugins` | istanza `plugins.manage` |  |
| `instance.listProviders` | L | `GET /api/ai-providers`<br>`GET /api/ai-usage/snapshots` | istanza `ai_providers.manage`<br>istanza `usage.view` |  |
| `instance.listWebhooks` | L | `GET /api/settings/webhooks` | istanza `integrations.manage` |  |
| `instance.modelFor` | in arrivo | — | — |  |
| `instance.modelIdFor` | in arrivo | — | — |  |
| `instance.moveProvider` | L+S | `GET /api/ai-providers`<br>`GET /api/ai-usage/snapshots`<br>`POST /api/ai-providers/reorder` | istanza `ai_providers.manage`<br>istanza `usage.view`<br>istanza `ai_providers.manage` |  |
| `instance.pauseQueue` | S | `POST /api/projects/:projectId/queue/pause` | progetto `project.settings.manage` |  |
| `instance.pickProvider` | in arrivo | — | — |  |
| `instance.previewWebhook` | L | `GET /api/settings/webhooks/preview` | istanza `integrations.manage` |  |
| `instance.queuePauseOf` | in arrivo | — | — |  |
| `instance.recordUsage` | in arrivo | — | — |  |
| `instance.regenerateWebhookSecret` | S | `POST /api/settings/webhooks/:id/secret` | istanza `integrations.manage` | 🔐 reauth |
| `instance.registerPlugin` | S | `POST /api/plugins` | istanza `plugins.manage` | 🔐 reauth |
| `instance.releaseBudgetHolds` | in arrivo | — | — |  |
| `instance.removePlugin` | S | `DELETE /api/plugins/:id` | istanza `plugins.manage` |  |
| `instance.renameProvider` | S | `PATCH /api/ai-providers/:id` | istanza `ai_providers.manage` | reauth parziale |
| `instance.replaceGitToken` | S | `PATCH /api/git-accounts/:id` | istanza `git_accounts.manage` | reauth parziale |
| `instance.replaceGoogleSecret` | S | `PATCH /api/settings/google-workspaces/:id` | istanza `integrations.manage` | reauth parziale |
| `instance.replaceProviderCredential` | S | `PATCH /api/ai-providers/:id` | istanza `ai_providers.manage` | reauth parziale |
| `instance.rerunSmoke` | S | `POST /api/plugins/:id/smoke` | istanza `plugins.manage` |  |
| `instance.resumeQueue` | S | `POST /api/projects/:projectId/queue/resume` | progetto `project.settings.manage` |  |
| `instance.retryJob` | S | `POST /api/instance/jobs/:id/retry` | progetto `project.settings.manage` |  |
| `instance.saveAutomation` | L+S | `GET /api/settings/automation`<br>`PUT /api/settings/automation` | istanza `settings.manage`<br>istanza `settings.manage` |  |
| `instance.saveBudget` | L+S | `GET /api/settings/instance`<br>`PUT /api/settings/instance` | istanza `settings.manage`<br>istanza `settings.manage` | reauth parziale |
| `instance.saveServerAnalysisSettings` | S | `PUT /api/settings/server-analysis` | istanza `settings.manage` |  |
| `instance.saveStorage` | S | `PUT /api/settings/instance` | istanza `settings.manage` | reauth parziale |
| `instance.setAttachments` | S | `PUT /api/settings/instance/attachments` | istanza `settings.manage` |  |
| `instance.setDefaultReviewer` | S | `DELETE /api/git-accounts/:id/default-reviewer`<br>`PUT /api/git-accounts/:id/default-reviewer` | istanza `git_accounts.manage`<br>istanza `git_accounts.manage` |  |
| `instance.setModel` | S | `PATCH /api/settings/models` | istanza `settings.manage` |  |
| `instance.setProviderEnabled` | S | `PATCH /api/ai-providers/:id` | istanza `ai_providers.manage` | reauth parziale |
| `instance.simulateBudgetReached` | in arrivo | — | — |  |
| `instance.simulateNextPluginOutcome` | in arrivo | — | — |  |
| `instance.simulateNextTest` | in arrivo | — | — |  |
| `instance.spentThisMonthUsd` | in arrivo | — | — |  |
| `instance.storageAllowsUploads` | in arrivo | — | — |  |
| `instance.testProvider` | L+S | `GET /api/ai-providers`<br>`POST /api/ai-providers/:id/test` | istanza `ai_providers.manage`<br>istanza `ai_providers.manage` |  |
| `instance.testStorage` | in arrivo | — | — |  |
| `instance.testWebhook` | S | `POST /api/settings/webhooks/:id/test` | istanza `integrations.manage` |  |
| `instance.updateGitAccount` | S | `PATCH /api/git-accounts/:id` | istanza `git_accounts.manage` | reauth parziale |
| `instance.updateGoogleApp` | S | `PATCH /api/settings/google-workspaces/:id` | istanza `integrations.manage` | reauth parziale |
| `instance.updatePluginRef` | S | `POST /api/plugins/:id/update` | istanza `plugins.manage` | 🔐 reauth |
| `instance.updateWebhook` | S | `PATCH /api/settings/webhooks/:id` | istanza `integrations.manage` | reauth parziale |
| `instance.validateGitAccount` | S | `POST /api/git-accounts/:id/validate` | istanza `git_accounts.manage` |  |
| `onInstanceChange` | senza rotta | — | — |  |

### Notifiche e ricerca

3 nomi: 3 integrati (2 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo, 1 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `listNotifications` | L | `GET /api/inbox`<br>`GET /api/people`<br>`GET /api/projects`<br>`GET /api/tickets/:id` | utente<br>utente<br>utente<br>progetto `member` | ponte del main: `instance.get` |
| `markNotification` | L+S | `GET /api/projects/archived`<br>`POST /api/inbox/:id/handled`<br>`POST /api/inbox/:id/move-to-new`<br>`POST /api/inbox/:id/read`<br>`POST /api/inbox/:id/restore`<br>`POST /api/inbox/:id/snooze`<br>`POST /api/inbox/:id/unread` | utente<br>utente<br>utente<br>utente<br>utente<br>utente<br>utente |  |
| `search` | L+S | `DELETE /api/servers/:id`<br>`GET /api/projects`<br>`GET /api/search` | istanza `monitor.manage`<br>utente<br>utente |  |

### Persone e attività

6 nomi: 6 integrati (2 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo, 1 con reauth.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `generateDailyReport` | S | `DELETE /api/servers/:id`<br>`POST /api/activity/generate` | istanza `monitor.manage`<br>istanza `settings.manage` |  |
| `linkCommitAuthor` | S | `POST /api/users/:id/git-identities` | istanza `users.manage` | 🔐 reauth |
| `listDailyReports` | L | `GET /api/activity` | utente |  |
| `listDepartments` | L | `GET /api/departments` | utente |  |
| `listPeople` | L | `GET /api/people` | utente |  |
| `listPeopleActivity` | L | `GET /api/people/activity` | istanza `people.activity.view` |  |

### Posta (`mail`)

45 nomi: 41 integrati (20 con scritture, 5 senza rotta: locali o derivati), 4 in arrivo, 1 con reauth, 2 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `mail.MAIL_MAX_ATTACHMENTS` | senza rotta | — | — |  |
| `mail.MAIL_MAX_BYTES` | senza rotta | — | — |  |
| `mail.MAIL_UNDO_MS` | senza rotta | — | — |  |
| `mail.attachDriveFile` | L+S | `GET /api/me/google/accounts`<br>`POST /api/me/mail/drafts/:id/attachments/drive` | utente<br>utente |  |
| `mail.chooseProjectFor` | S | `POST /api/me/mail/proposals/:id/choose-project` | utente |  |
| `mail.confirmMailProposal` | S | `POST /api/me/mail/proposals/:id/confirm`<br>`POST /api/me/mail/proposals/:id/confirm-with-members` | utente<br>utente | 🔐 reauth |
| `mail.deleteFailedSend` | L+S | `GET /api/me/google/accounts`<br>`POST /api/me/mail/outgoing/:id/discard` | utente<br>utente |  |
| `mail.discardDraft` | S | `DELETE /api/me/mail/drafts/:id` | utente |  |
| `mail.getDraft` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/drafts/compose` | utente<br>utente |  |
| `mail.getMailProposal` | L | `GET /api/me/mail/proposals/:id` | utente |  |
| `mail.getMailThread` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/:source/:id/original`<br>`GET /api/me/mail/threads/:threadId`<br>`GET /api/people` | utente<br>utente<br>utente<br>utente |  |
| `mail.getMeetingByNote` | L | `GET /api/me/meetings/:noteId` | utente |  |
| `mail.getMeetingSummary` | L | `GET /api/me/calendar/events/:id/summary` | utente |  |
| `mail.handMailProposal` | S | `POST /api/me/mail/proposals/:id/hand` | utente |  |
| `mail.ignoreMailProposal` | S | `POST /api/me/mail/proposals/:id/ignore` | utente |  |
| `mail.listDrafts` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/drafts` | utente<br>utente |  |
| `mail.listImportantMail` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/threads`<br>`GET /api/projects` | utente<br>utente<br>utente |  |
| `mail.listMailDecisions` | L | `GET /api/me/mail/proposals` | utente |  |
| `mail.listMailProposals` | L | `GET /api/me/mail/proposals` | utente |  |
| `mail.listMailThreads` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/threads`<br>`GET /api/projects` | utente<br>utente<br>utente |  |
| `mail.listMailboxes` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts` | istanza `monitor.manage`<br>utente |  |
| `mail.listWaitingCustomers` | L | `GET /api/me/waiting-customers` | utente |  |
| `mail.mailClassificationHistory` | in arrivo | — | — |  |
| `mail.markRead` | S | `POST /api/me/mail/threads/:threadId/read` | utente |  |
| `mail.markUnread` | S | `POST /api/me/mail/threads/:threadId/read` | utente |  |
| `mail.permissionForAction` | in arrivo | — | — |  |
| `mail.reassignMailProposal` | S | `POST /api/me/mail/proposals/:id/reassign` | utente |  |
| `mail.reproposeMessage` | S | `POST /api/me/mail/:source/:id/repropose` | utente |  |
| `mail.restoreDiscardedDraft` | L+S | `POST /api/me/mail/drafts/:id/attachments`<br>`DELETE /api/me/mail/drafts/:id/attachments/:attachmentId`<br>`DELETE /api/servers/:id`<br>`GET /api/me/google/accounts`<br>`POST /api/me/mail/drafts/:id/attachments/drive`<br>`PUT /api/me/mail/drafts` | utente<br>utente<br>istanza `monitor.manage`<br>utente<br>utente<br>utente | ponte del main: `api.upload` |
| `mail.retrySend` | S | `POST /api/me/mail/outgoing/:id/retry` | utente |  |
| `mail.saveDraft` | L+S | `POST /api/me/mail/drafts/:id/attachments`<br>`DELETE /api/me/mail/drafts/:id/attachments/:attachmentId`<br>`DELETE /api/servers/:id`<br>`GET /api/me/google/accounts`<br>`POST /api/me/mail/drafts/:id/attachments/drive`<br>`PUT /api/me/mail/drafts` | utente<br>utente<br>istanza `monitor.manage`<br>utente<br>utente<br>utente | ponte del main: `api.upload` |
| `mail.searchMail` | L | `GET /api/me/google/accounts`<br>`GET /api/me/mail/threads`<br>`GET /api/projects` | utente<br>utente<br>utente |  |
| `mail.sendDraft` | L+S | `GET /api/me/mail/drafts`<br>`POST /api/me/mail/drafts/:id/send` | utente<br>utente |  |
| `mail.setProposalsEnabled` | L+S | `GET /api/me/google/accounts`<br>`PATCH /api/me/google/accounts/:id` | utente<br>utente |  |
| `mail.simulateReply` | in arrivo | — | — |  |
| `mail.streamClaudeDraft` | L+S | `POST /api/me/mail/drafts/claude`<br>`GET /api/me/google/accounts` | utente<br>utente |  |
| `mail.suggestRecipients` | L | `GET /api/me/mail/recipients` | utente |  |
| `mail.syncMailbox` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts`<br>`POST /api/me/google/accounts/:id/sync` | istanza `monitor.manage`<br>utente<br>utente |  |
| `mail.tasksBornFrom` | L | `GET /api/me/calendar/events/:id/tasks` | utente |  |
| `mail.tasksOfNote` | L | `GET /api/me/meetings/:noteId/tasks` | utente |  |
| `mail.threadOfMessage` | in arrivo | — | — |  |
| `mail.undoSend` | L+S | `GET /api/me/google/accounts`<br>`POST /api/me/mail/outgoing/:id/undo` | utente<br>utente |  |
| `mail.whenMailIdle` | senza rotta | — | — |  |
| `mail.whenMailSynced` | senza rotta | — | — |  |
| `mail.whenSendSettled` | L | `GET /api/me/mail/outgoing/:id` | utente |  |

### Progetti e panoramica

15 nomi: 15 integrati (5 con scritture, 1 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `createProject` | L+S | `GET /api/projects/:projectId/integration`<br>`POST /api/projects` | progetto `member`<br>istanza `projects.create` |  |
| `decisionLogTruncated` | senza rotta | — | — |  |
| `getLatestBrief` | L | `GET /api/projects/:projectId/briefs/latest` | progetto `tickets.view_all` |  |
| `getProjectByCode` | L | `GET /api/agent-sessions`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>progetto `member` |  |
| `listDecisionLog` | L+S | `DELETE /api/servers/:id`<br>`GET /api/projects/:projectId/decisions` | istanza `monitor.manage`<br>progetto `member` |  |
| `listPinnedProjectIds` | L | `GET /api/me/follows` | utente |  |
| `listPortfolioActivityPage` | L | `GET /api/activity/portfolio` | utente |  |
| `listProjectPulses` | L | `GET /api/agent-sessions`<br>`GET /api/decisions`<br>`GET /api/me/claude-decisions`<br>`GET /api/milestones`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/statuses`<br>`GET /api/projects/pulses`<br>`GET /api/requests/to-convert`<br>`GET /api/tasks`<br>`GET /api/tasks/stalled` | utente<br>utente<br>utente<br>progetto `member`<br>utente<br>progetto `member`<br>utente<br>utente<br>utente<br>utente |  |
| `listProjects` | L | `GET /api/agent-sessions`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>utente<br>progetto `member` |  |
| `listTimelinePage` | L | `GET /api/projects/:projectId/chronology` | progetto `member` |  |
| `listWaitingOnMeProjectIds` | L | `GET /api/decisions`<br>`GET /api/me/claude-decisions`<br>`GET /api/tickets/:id` | utente<br>utente<br>progetto `member` |  |
| `projectPulse` | L | `GET /api/agent-sessions`<br>`GET /api/decisions`<br>`GET /api/me/claude-decisions`<br>`GET /api/milestones`<br>`GET /api/projects/:projectId/statuses`<br>`GET /api/projects/pulses`<br>`GET /api/requests/to-convert`<br>`GET /api/tasks`<br>`GET /api/tasks/stalled` | utente<br>utente<br>utente<br>progetto `member`<br>progetto `member`<br>utente<br>utente<br>utente<br>utente |  |
| `recordDecision` | S | `POST /api/projects/:projectId/decisions` | progetto `decisions.record` |  |
| `setDecisionSuperseded` | S | `PATCH /api/projects/:projectId/decisions/:decisionId` | progetto `decisions.record` |  |
| `setPinned` | L+S | `GET /api/me/follows`<br>`PUT /api/me/follows` | utente<br>utente |  |

### Registro delle modifiche (`changelog`)

5 nomi: 3 integrati (0 con scritture, 0 senza rotta: locali o derivati), 2 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `changelog.listChangeFilterChoices` | L | `GET /api/change-log/filters` | utente |  |
| `changelog.listChanges` | in arrivo | — | — |  |
| `changelog.listChangesPage` | L | `GET /api/auth/me`<br>`GET /api/change-log`<br>`GET /api/people` | utente<br>utente<br>utente |  |
| `changelog.listProjectChanges` | in arrivo | — | — |  |
| `changelog.listProjectChangesPage` | L | `GET /api/auth/me`<br>`GET /api/people`<br>`GET /api/projects/:projectId/change-log` | utente<br>utente<br>progetto `member` |  |

### Richieste

12 nomi: 12 integrati (8 con scritture, 0 senza rotta: locali o derivati), 0 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `archiveRequest` | S | `POST /api/requests/:id/archive` | progetto `backlog.edit` |  |
| `convertRequest` | L+S | `GET /api/requests/:id`<br>`POST /api/tasks` | progetto `member`<br>progetto `tickets.create` |  |
| `createRequest` | L+S | `GET /api/requests/jobs/:jobId`<br>`POST /api/requests` | progetto `member`<br>progetto `backlog.create` |  |
| `createRequestFromQuestion` | S | `POST /api/requests` | progetto `backlog.create` |  |
| `getRequest` | L | `GET /api/requests/:id` | progetto `member` |  |
| `getRequestByCode` | L | `GET /api/requests/by-code/:code` | utente |  |
| `listRequests` | L | `GET /api/requests` | progetto `member` |  |
| `listRequestsToConvert` | L | `GET /api/requests/to-convert` | utente |  |
| `mergeRequest` | S | `POST /api/requests/:id/merge` | progetto `backlog.edit` |  |
| `reopenRequest` | S | `POST /api/requests/:id/reopen` | progetto `backlog.edit` |  |
| `restoreRequest` | S | `POST /api/requests/:id/restore` | progetto `backlog.edit` |  |
| `updateRequest` | L+S | `GET /api/requests/:id`<br>`PATCH /api/requests/:id`<br>`POST /api/requests/:id/suggestions/accept`<br>`POST /api/requests/:id/suggestions/dismiss` | progetto `member`<br>progetto `backlog.edit`<br>progetto `backlog.edit`<br>progetto `backlog.edit` |  |

### Rilasci e PR (`releases`)

24 nomi: 20 integrati (17 con scritture, 0 senza rotta: locali o derivati), 4 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `releases.advancePrWork` | in arrivo | — | — |  |
| `releases.createEnvironment` | L+S | `GET /api/servers`<br>`POST /api/projects/:projectId/environments` | utente<br>progetto `environments.manage` |  |
| `releases.deleteEnvironment` | S | `DELETE /api/projects/:projectId/environments/:environmentId`<br>`DELETE /api/servers/:id` | progetto `environments.manage`<br>istanza `monitor.manage` | reauth parziale |
| `releases.explainRelease` | L+S | `GET /api/claude/conversations`<br>`POST /api/claude/conversations` | utente<br>utente |  |
| `releases.fixRelease` | S | `POST /api/releases/:code/fix` | utente |  |
| `releases.getRelease` | L+S | `GET /api/releases/:code`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/releases/:code/fix` | utente<br>utente<br>utente |  |
| `releases.getRepositorySettings` | L | `GET /api/repositories:param` ⚠ non trovata | — |  |
| `releases.listEnvironments` | L | `GET /api/auth/me`<br>`GET /api/projects/:projectId/environments`<br>`GET /api/repositories:param` ⚠ non trovata | utente<br>progetto `member`<br>— |  |
| `releases.listMyReleases` | L+S | `DELETE /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`POST /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`GET /api/me/releases`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections` | utente<br>utente<br>utente<br>utente<br>progetto `corrections.request` |  |
| `releases.listOpenPrs` | L+S | `DELETE /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`POST /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`GET /api/projects/:projectId/pulls`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections` | utente<br>utente<br>utente<br>utente<br>progetto `corrections.request` |  |
| `releases.listReleaseQueue` | L+S | `DELETE /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`POST /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`GET /api/projects/:projectId/pulls`<br>`GET /api/release-queue`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections` | utente<br>utente<br>utente<br>utente<br>utente<br>progetto `corrections.request` |  |
| `releases.listReleases` | L+S | `GET /api/projects/:projectId/releases`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/releases/:code/fix` | utente<br>utente<br>utente |  |
| `releases.mergePr` | S | `POST /api/tickets/:id/repositories/:repositoryId/release` | progetto `release.merge` |  |
| `releases.requestPrCorrection` | S | `POST /api/tickets/:id/repositories/:repositoryId/corrections` | progetto `corrections.request` |  |
| `releases.searchReleases` | L | `GET /api/releases/search` | utente |  |
| `releases.setEnvironmentContainers` | S | `PUT /api/projects/:projectId/environments/:environmentId/containers` | progetto `environments.manage` |  |
| `releases.setPrAnalysisOnly` | L+S | `DELETE /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`POST /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`GET /api/projects/:projectId/pulls`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections` | utente<br>utente<br>utente<br>utente<br>progetto `corrections.request` |  |
| `releases.setPrReleaseNotes` | L+S | `DELETE /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`POST /api/repositories/:repositoryId/pulls/:prNumber/analysis-only`<br>`GET /api/projects/:projectId/pulls`<br>`GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes`<br>`POST /api/tickets/:id/repositories/:repositoryId/corrections`<br>`PUT /api/repositories/:repositoryId/pulls/:prNumber/release-notes` | utente<br>utente<br>utente<br>utente<br>progetto `corrections.request`<br>utente |  |
| `releases.setReleasePipeline` | S | `PATCH /api/repositories/:slug` | progetto `repos.manage` |  |
| `releases.setRepoPrMode` | S | `PATCH /api/repositories/:slug` | progetto `repos.manage` |  |
| `releases.simulateAuthorPush` | in arrivo | — | — |  |
| `releases.simulateRunOutcome` | in arrivo | — | — |  |
| `releases.simulateSeenOnServer` | in arrivo | — | — |  |
| `releases.updateEnvironment` | L+S | `GET /api/servers`<br>`PATCH /api/projects/:projectId/environments/:environmentId` | utente<br>progetto `environments.manage` |  |

### Server (`servers`)

34 nomi: 27 integrati (18 con scritture, 0 senza rotta: locali o derivati), 7 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `servers.RECENT_CPU_POINTS` | in arrivo | — | — |  |
| `servers.approveServerFix` | S | `POST /api/tasks/:ticketId/server-fix/approve` | progetto `plans.approve` |  |
| `servers.createCheck` | L+S | `GET /api/servers/by-code/:code`<br>`POST /api/servers/:id/checks` | utente<br>istanza `monitor.manage` |  |
| `servers.createServer` | S | `POST /api/servers` | istanza `monitor.manage` |  |
| `servers.deleteCheck` | L+S | `DELETE /api/servers/:id`<br>`DELETE /api/servers/:id/checks/:checkId`<br>`GET /api/servers/by-code/:code` | istanza `monitor.manage`<br>istanza `monitor.manage`<br>utente |  |
| `servers.deleteServer` | L+S | `DELETE /api/servers/:id`<br>`GET /api/servers/by-code/:code` | istanza `monitor.manage`<br>utente |  |
| `servers.getCommandKey` | L | `GET /api/servers/command-key` | istanza `monitor.manage` |  |
| `servers.getInstallCommand` | L | `GET /api/servers/:id/ssh`<br>`GET /api/servers/by-code/:code` | istanza `servers.ssh.manage`<br>utente |  |
| `servers.getRemovalCommand` | L | `GET /api/servers/:id/ssh`<br>`GET /api/servers/by-code/:code` | istanza `servers.ssh.manage`<br>utente |  |
| `servers.getServer` | L | `GET /api/servers/:id/analyses`<br>`GET /api/servers/:id/ssh`<br>`GET /api/servers/by-code/:code` | utente<br>istanza `servers.ssh.manage`<br>utente |  |
| `servers.getServerMetrics` | L | `GET /api/servers/:id/metrics`<br>`GET /api/servers/by-code/:code` | utente<br>utente |  |
| `servers.getServerTaskInfo` | L+S | `GET /api/tasks/:ticketId/server`<br>`GET /api/tasks/:ticketId/server-fix/commands`<br>`POST /api/releases/:code/fix` | progetto `member`<br>progetto `member`<br>utente |  |
| `servers.linkSshAccess` | L+S | `GET /api/servers/by-code/:code`<br>`PUT /api/servers/:id/ssh` | utente<br>istanza `servers.ssh.manage` |  |
| `servers.listAllServers` | L | `GET /api/servers` | utente |  |
| `servers.listLinkableServers` | L | `GET /api/servers` | utente |  |
| `servers.listProjectServers` | L | `GET /api/servers` | utente |  |
| `servers.regenerateAgentKey` | L+S | `GET /api/servers/by-code/:code`<br>`POST /api/servers/:id/regenerate-key` | utente<br>istanza `monitor.manage` |  |
| `servers.regenerateSshAccess` | L+S | `GET /api/servers/by-code/:code`<br>`POST /api/servers/:id/ssh/regenerate` | utente<br>istanza `servers.ssh.manage` |  |
| `servers.rejectServerFix` | S | `POST /api/tasks/:ticketId/server-fix/reject` | progetto `plans.approve` |  |
| `servers.revokeSshAccess` | L+S | `DELETE /api/servers/:id/ssh`<br>`GET /api/servers/by-code/:code` | istanza `servers.ssh.manage`<br>utente |  |
| `servers.searchServers` | L | `GET /api/servers/search` | utente |  |
| `servers.serverHref` | in arrivo | — | — |  |
| `servers.setThresholds` | L+S | `GET /api/servers/by-code/:code`<br>`PATCH /api/servers/:id` | utente<br>istanza `monitor.manage` |  |
| `servers.simulateFixCheck` | in arrivo | — | — |  |
| `servers.simulateServerAlert` | in arrivo | — | — |  |
| `servers.simulateServerRecovery` | in arrivo | — | — |  |
| `servers.simulateSshUnreachable` | in arrivo | — | — |  |
| `servers.simulateSshVerifyOutcome` | in arrivo | — | — |  |
| `servers.startServerAnalysis` | L+S | `GET /api/servers/by-code/:code`<br>`POST /api/servers/:id/analyses` | utente<br>utente |  |
| `servers.startServerFix` | S | `POST /api/tasks/:ticketId/server-fix` | progetto `servers.operate` |  |
| `servers.stopServerFix` | S | `POST /api/tasks/:ticketId/server-fix/stop` | progetto `member` |  |
| `servers.updateCheck` | L+S | `GET /api/servers/by-code/:code`<br>`PUT /api/servers/:id/checks/:checkId` | utente<br>istanza `monitor.manage` |  |
| `servers.updateServer` | L+S | `GET /api/servers/by-code/:code`<br>`PATCH /api/servers/:id` | utente<br>istanza `monitor.manage` |  |
| `servers.verifySshAccess` | L+S | `GET /api/servers/by-code/:code`<br>`POST /api/servers/:id/ssh/verify` | utente<br>istanza `servers.ssh.manage` |  |

### Sessione e account

49 nomi: 40 integrati (32 con scritture, 1 senza rotta: locali o derivati), 9 in arrivo, 11 con reauth, 2 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `auth.confirmLoginEnrollment` | L+S | `GET /api/me/security`<br>`POST /api/auth/second-factor/enroll/confirm`<br>`POST /api/me/security/backup-codes` | utente<br>secondo fattore<br>utente | 🔐 reauth |
| `auth.createFirstAdmin` | S | `? /api/auth` ⚠ non trovata<br>`POST /api/auth/setup` | —<br>pubblica |  |
| `auth.desktopHandoff` | S | `POST /api/auth/desktop-handoff` | utente | 🔐 reauth |
| `auth.enrollDuringReauth` | in arrivo | — | — |  |
| `auth.getEntry` | in arrivo | — | — |  |
| `auth.getInvite` | L+S | `? /api/auth` ⚠ non trovata<br>`GET /api/auth/invites/:token` | —<br>pubblica |  |
| `auth.getResetLink` | L+S | `? /api/auth` ⚠ non trovata<br>`GET /api/auth/password-reset/:token` | —<br>pubblica |  |
| `auth.isInstanceEmpty` | in arrivo | — | — |  |
| `auth.login` | S | `POST /api/auth/login` | pubblica | porta credenziali |
| `auth.loginSecondFactor` | S | `POST /api/auth/second-factor/passkey/options`<br>`POST /api/auth/second-factor/passkey/verify`<br>`POST /api/auth/second-factor/verify` | secondo fattore<br>secondo fattore<br>secondo fattore |  |
| `auth.loginStage` | L | `GET /api/auth/second-factor` | secondo fattore |  |
| `auth.logout` | S | `POST /api/auth/logout` | pubblica | ponte del main: `session.logout` |
| `auth.passMinutes` | in arrivo | — | — |  |
| `auth.prototypeAccounts` | in arrivo | — | — |  |
| `auth.readEntry` | senza rotta | — | — |  |
| `auth.reauthenticate` | S | `POST /api/auth/desktop-reauth`<br>`POST /api/me/security/reauth`<br>`POST /api/me/security/reauth/passkey/options`<br>`POST /api/me/security/reauth/passkey/verify` | utente<br>utente<br>utente<br>utente |  |
| `auth.register` | S | `? /api/auth` ⚠ non trovata<br>`POST /api/auth/register` | —<br>pubblica |  |
| `auth.resetPassword` | L+S | `? /api/auth` ⚠ non trovata<br>`GET /api/auth/me`<br>`POST /api/auth/password-reset/:token` | —<br>utente<br>pubblica |  |
| `auth.resetToEmptyInstance` | in arrivo | — | — |  |
| `auth.simulateInviteLink` | in arrivo | — | — |  |
| `auth.startLoginEnrollment` | S | `POST /api/auth/second-factor/enroll` | secondo fattore |  |
| `getSessionPerson` | L+S | `DELETE /api/servers/:id`<br>`GET /api/auth/me`<br>`GET /api/auth/setup`<br>`GET /api/repositories/:repositoryId/docs/tree` | istanza `monitor.manage`<br>utente<br>pubblica<br>progetto `docs.view` |  |
| `getViewer` | L | `GET /api/auth/me` | utente |  |
| `me.addPasskey` | L+S | `GET /api/me/security`<br>`POST /api/me/security/passkeys`<br>`POST /api/me/security/passkeys/options` | utente<br>utente<br>utente | solo browser; 🔐 reauth |
| `me.cancelEmailChange` | S | `DELETE /api/me/email-change` | utente |  |
| `me.changePassword` | L+S | `GET /api/me/sessions`<br>`POST /api/auth/me/password` | utente<br>utente | 🔐 reauth |
| `me.confirmEmailChange` | S | `POST /api/auth/email-change/confirm` | pubblica |  |
| `me.confirmTotp` | L+S | `GET /api/me/security`<br>`POST /api/me/security/backup-codes`<br>`POST /api/me/security/totp/setup/confirm` | utente<br>utente<br>utente | 🔐 reauth; 🔐 reauth (setup) |
| `me.connectMailbox` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts` | istanza `monitor.manage`<br>utente |  |
| `me.createClaudeCodeCommand` | S | `POST /api/pats` | utente | ponte del main: `instance.get`; 🔐 reauth |
| `me.createToken` | S | `POST /api/pats` | utente | 🔐 reauth |
| `me.disconnectMailbox` | L+S | `DELETE /api/me/google/accounts/:id`<br>`GET /api/me/google/accounts` | utente<br>utente |  |
| `me.endSession` | S | `DELETE /api/me/sessions/:id` | utente |  |
| `me.getEmailChangeLink` | L | `GET /api/auth/email-change/:token` | pubblica |  |
| `me.getMyProfile` | L | `GET /api/auth/me`<br>`GET /api/me/email-change` | utente<br>utente |  |
| `me.getMySecurity` | L | `GET /api/me/security`<br>`GET /api/me/sessions` | utente<br>utente |  |
| `me.listMyMailboxes` | L+S | `DELETE /api/servers/:id`<br>`GET /api/me/google/accounts` | istanza `monitor.manage`<br>utente |  |
| `me.listTokens` | L | `GET /api/pats` | utente |  |
| `me.reconnectMailbox` | L | `GET /api/me/google/accounts` | utente |  |
| `me.regenerateBackupCodes` | L+S | `GET /api/me/security`<br>`POST /api/me/security/backup-codes` | utente<br>utente | 🔐 reauth |
| `me.removePasskey` | L+S | `GET /api/me/security`<br>`DELETE /api/me/security/passkeys/:id` | utente<br>utente | 🔐 reauth |
| `me.renamePasskey` | L+S | `GET /api/me/security`<br>`PATCH /api/me/security/passkeys/:id` | utente<br>utente |  |
| `me.requestEmailChange` | S | `POST /api/me/email-change` | utente | 🔐 reauth |
| `me.revokeToken` | S | `DELETE /api/pats/:id` | utente |  |
| `me.setEmailTransportForPrototype` | in arrivo | — | — |  |
| `me.setProposals` | L+S | `GET /api/me/google/accounts`<br>`PATCH /api/me/google/accounts/:id` | utente<br>utente |  |
| `me.simulateEmailChangeLink` | in arrivo | — | — |  |
| `me.startTotpSetup` | L+S | `GET /api/me/security`<br>`POST /api/me/security/totp/setup` | utente<br>utente | 🔐 reauth (setup) |
| `me.updateProfile` | S | `DELETE /api/me/avatar`<br>`PATCH /api/auth/me`<br>`PUT /api/me/avatar` | utente<br>utente<br>utente |  |

### Support (`support`)

16 nomi: 12 integrati (7 con scritture, 0 senza rotta: locali o derivati), 4 in arrivo, 1 con reauth.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `support.createWidget` | S | `POST /api/projects/:projectId/widgets` | progetto `widget.manage` |  |
| `support.customerPreview` | L | `GET /api/support/conversations/by-code/:code/preview` | utente |  |
| `support.deleteWidget` | S | `DELETE /api/projects/:projectId/widgets/:widgetId`<br>`DELETE /api/servers/:id` | progetto `widget.manage`<br>istanza `monitor.manage` |  |
| `support.getSupportConversation` | L | `GET /api/support/conversations/by-code/:code` | utente |  |
| `support.listSupportConversations` | L | `GET /api/projects/:projectId/support/conversations` | utente |  |
| `support.listWidgets` | L | `GET /api/projects/:projectId/widgets` | progetto `member` |  |
| `support.markNotConcluded` | S | `POST /api/support/conversations/by-code/:code/not-concluded` | utente |  |
| `support.myRequestStatus` | in arrivo | — | — |  |
| `support.openRequestFrom` | S | `POST /api/support/conversations/by-code/:code/request` | utente |  |
| `support.regenerateIdentitySecret` | S | `POST /api/projects/:projectId/widgets/:widgetId/identity-secret` | progetto `widget.manage` | 🔐 reauth |
| `support.replyToCollaborator` | S | `POST /api/support/conversations/by-code/:code/replies` | utente |  |
| `support.searchSupport` | L | `GET /api/support/search` | utente |  |
| `support.simulateCustomerLeaves` | in arrivo | — | — |  |
| `support.simulateCustomerMessage` | in arrivo | — | — |  |
| `support.simulateTriageDone` | in arrivo | — | — |  |
| `support.updateWidget` | S | `PUT /api/projects/:projectId/widgets/:widgetId` | progetto `widget.manage` |  |

### Task

37 nomi: 37 integrati (24 con scritture, 1 senza rotta: locali o derivati), 0 in arrivo, 1 della cassaforte.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `addAttachment` | L+S | `GET /api/tasks/by-code/:code`<br>`POST /api/tickets/:ticketId/attachments` | utente<br>progetto `tickets.comment` |  |
| `addComment` | S | `POST /api/tickets/:ticketId/comments` | progetto `tickets.comment` |  |
| `addLink` | L+S | `GET /api/tasks/by-code/:code`<br>`POST /api/tickets/:id/links` | utente<br>progetto `tickets.edit` |  |
| `answerDecision` | S | `POST /api/decisions/:id/answer` | utente |  |
| `askDecision` | S | `POST /api/tasks/:ticketId/decisions` | progetto `tickets.comment` |  |
| `bulkUpdateTasks` | S | `PATCH /api/tasks/bulk` | utente |  |
| `clearManualStall` | S | `DELETE /api/tasks/:ticketId/manual-stall` | progetto `tickets.edit` |  |
| `countTasks` | L | `GET /api/tasks` | utente |  |
| `createMilestone` | S | `POST /api/milestones` | progetto `tickets.edit` |  |
| `createTask` | L+S | `GET /api/requests/:id`<br>`POST /api/tasks` | progetto `member`<br>progetto `tickets.create` |  |
| `deleteComment` | S | `DELETE /api/tickets/:ticketId/comments/:commentId` | progetto `member` |  |
| `deleteMilestone` | S | `DELETE /api/milestones/:id` | progetto `tickets.edit` |  |
| `deleteTask` | S | `DELETE /api/tasks/:ticketId` | progetto `member` |  |
| `downloadTaskAttachment` | L | `GET /api/attachments/:attachmentId/download` | progetto `member` | ponte del main: `api.download` |
| `editComment` | S | `PATCH /api/tickets/:ticketId/comments/:commentId` | progetto `member` |  |
| `followTask` | L+S | `DELETE /api/tasks/:ticketId/follow`<br>`GET /api/tasks/by-code/:code`<br>`PUT /api/tasks/:ticketId/follow` | progetto `member`<br>utente<br>progetto `member` |  |
| `getTaskByCode` | L | `GET /api/tasks/by-code/:code` | utente |  |
| `getTaskDeletion` | L | `GET /api/tasks/:ticketId/deletion` | progetto `member` |  |
| `getTaskWorkSummary` | L | `GET /api/tasks/:ticketId/work` | progetto `member` |  |
| `listActivity` | L | `GET /api/tasks/:ticketId/activity` | progetto `member` |  |
| `listDayArrangements` | L | `GET /api/me/day-arrangements` | utente |  |
| `listDecisionRequests` | L | `GET /api/decisions` | utente |  |
| `listMilestones` | L | `GET /api/agent-sessions`<br>`GET /api/milestones`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members` | utente<br>progetto `member`<br>utente<br>progetto `member` |  |
| `listProjectStatuses` | L | `GET /api/projects/:projectId/statuses` | progetto `member` |  |
| `listStalled` | L | `GET /api/tasks/stalled` | utente |  |
| `listTasks` | L | `GET /api/tasks` | utente |  |
| `planTask` | S | `POST /api/tasks/:ticketId/plan` | progetto `member` |  |
| `removeAttachment` | L+S | `DELETE /api/attachments/:attachmentId`<br>`GET /api/tasks/by-code/:code` | progetto `member`<br>utente |  |
| `removeLink` | L+S | `DELETE /api/tickets/:id/links/:linkId`<br>`GET /api/tasks/by-code/:code`<br>`GET /api/tickets/:id/links` | progetto `tickets.edit`<br>utente<br>progetto `member` |  |
| `setDay` | S | `PUT /api/tasks/:ticketId/day` | progetto `member` |  |
| `setManualStall` | S | `PUT /api/tasks/:ticketId/manual-stall` | progetto `tickets.edit` |  |
| `setProjectStatuses` | S | `PUT /api/projects/:projectId/statuses` | progetto `project.settings.manage` |  |
| `setStallThresholds` | L+S | `GET /api/agent-sessions`<br>`GET /api/projects`<br>`GET /api/projects/:projectId/members`<br>`PUT /api/projects/:projectId/stall-thresholds` | utente<br>utente<br>progetto `member`<br>progetto `project.settings.manage` |  |
| `tasksTruncated` | senza rotta | — | — |  |
| `updateMilestone` | S | `PATCH /api/milestones/:id` | progetto `tickets.edit` |  |
| `updateTask` | S | `PATCH /api/tasks/:ticketId` | progetto `tickets.edit` |  |
| `withdrawDecision` | S | `POST /api/decisions/:id/withdraw` | utente |  |

### Non integrate (stub generati, fuori dai namespace)

57 nomi: 1 integrati (0 con scritture, 1 senza rotta: locali o derivati), 56 in arrivo.

| Nome dell'adattatore | L/S | Rotta | Permesso | Note |
|---|---|---|---|---|
| `MENTION_LIMIT` | senza rotta | — | — |  |
| `addCommentAs` | in arrivo | — | — |  |
| `aiStartBlock` | in arrivo | — | — |  |
| `applyActions` | in arrivo | — | — |  |
| `archiveRequestAs` | in arrivo | — | — |  |
| `assignedRecipientOf` | in arrivo | — | — |  |
| `canRecordDecisions` | in arrivo | — | — |  |
| `checkNewMilestone` | in arrivo | — | — |  |
| `checkNewRequest` | in arrivo | — | — |  |
| `checkNewTask` | in arrivo | — | — |  |
| `checkOpenProposal` | in arrivo | — | — |  |
| `completeEditedProposal` | in arrivo | — | — |  |
| `convertRequestAs` | in arrivo | — | — |  |
| `createConversationAs` | in arrivo | — | — |  |
| `createMilestoneAs` | in arrivo | — | — |  |
| `createRequestAs` | in arrivo | — | — |  |
| `createTaskAs` | in arrivo | — | — |  |
| `defaultDepartmentOf` | in arrivo | — | — |  |
| `deleteCommentAs` | in arrivo | — | — |  |
| `deleteFilterAs` | in arrivo | — | — |  |
| `deleteMilestoneAs` | in arrivo | — | — |  |
| `failNext` | in arrivo | — | — |  |
| `followScripts` | in arrivo | — | — |  |
| `insertRequest` | in arrivo | — | — |  |
| `launchRun` | in arrivo | — | — |  |
| `listDocPages` | in arrivo | — | — |  |
| `listPortfolioActivity` | in arrivo | — | — |  |
| `listTimeline` | in arrivo | — | — |  |
| `nextTaskNumber` | in arrivo | — | — |  |
| `openRoutes` | in arrivo | — | — |  |
| `openRunAs` | in arrivo | — | — |  |
| `openWorkConversationAs` | in arrivo | — | — |  |
| `planRecipientsOf` | in arrivo | — | — |  |
| `planTaskAs` | in arrivo | — | — |  |
| `prepareRunAs` | in arrivo | — | — |  |
| `proposalActionArgs` | in arrivo | — | — |  |
| `readsAs` | in arrivo | — | — |  |
| `reassignTask` | in arrivo | — | — |  |
| `reopenRequestAs` | in arrivo | — | — |  |
| `requestChangesAs` | in arrivo | — | — |  |
| `resetApi` | in arrivo | — | — |  |
| `runIdentity` | in arrivo | — | — |  |
| `runScript` | in arrivo | — | — |  |
| `saveFilterAs` | in arrivo | — | — |  |
| `setLatency` | in arrivo | — | — |  |
| `setStreamLatency` | in arrivo | — | — |  |
| `settleCancelledProposal` | in arrivo | — | — |  |
| `settleEditedProposal` | in arrivo | — | — |  |
| `settleProposal` | in arrivo | — | — |  |
| `simulateDisconnect` | in arrivo | — | — |  |
| `slipWeeks` | in arrivo | — | — |  |
| `startOrHold` | in arrivo | — | — |  |
| `startRefine` | in arrivo | — | — |  |
| `startRunAs` | in arrivo | — | — |  |
| `updateTaskAs` | in arrivo | — | — |  |
| `visibleProjectIds` | in arrivo | — | — |  |
| `whenIdle` | in arrivo | — | — |  |

## Il ponte del main per la cassaforte

Le pagine chiamano `window.stubwise.vault.<x>` (`src/preload/index.ts`, canali `vault:*` in `src/main/vaultIpc.ts`); il main chiama il server con il PAT del desktop (`src/main/vaultOps.ts`, `vaultRemote.ts`). Le righe dei nomi `vault.*` qui sopra includono già queste rotte.

| Ponte | Rotte del main |
|---|---|
| `vault.status` | nessuna (stato locale, Touch ID, eventi) |
| `vault.unlock` | `GET /api/vault/device-seals/mine` |
| `vault.lock` | nessuna (stato locale, Touch ID, eventi) |
| `vault.forget` | `DELETE /api/vault/device-seals/mine` |
| `vault.pairStart` | `POST /api/vault/device-pairings` |
| `vault.pairCancel` | nessuna (stato locale, Touch ID, eventi) |
| `vault.show` | `POST /api/vault/actor-challenge`<br>`POST /api/credentials/:id/reveal` |
| `vault.copy` | `POST /api/vault/actor-challenge`<br>`POST /api/credentials/:id/reveal` |
| `vault.share` | `GET /api/credentials/:id/readers/preview`<br>`POST /api/credentials/:id/readers` |
| `vault.removeReader` | `DELETE /api/credentials/:id/readers/:readerId` |
| `vault.pending` | `GET /api/vault/pending` |
| `vault.confirm` | `POST /api/vault/pending/:id/confirm` |
| `vault.reject` | `POST /api/vault/pending/:id/reject` |
| `vault.macs` | `GET /api/vault/device-seals` |
| `vault.removeMac` | `DELETE /api/vault/device-seals/:id` |
| `vault.create` | `POST /api/projects/:projectId/credentials` |
| `vault.setPassword` | `PUT /api/credentials/:id/password` |
| `vault.serverStatus` | `GET /api/vault/status` |
| `vault.mine` | `GET /api/vault/credentials` |
| `vault.onChanged` | nessuna (stato locale, Touch ID, eventi) |
| `vault.onPaired` | nessuna (stato locale, Touch ID, eventi) |

## Percorsi da verificare a mano

Composti dall'adattatore e non trovati nel registro del server, così come li vede l'analisi:

- `? /api/auth`
- `GET /api/repositories:param`

## Rotte del server che l'app non chiama (171)

Per il design dei tool: il server ha queste rotte sotto `/api` e l'app non le usa (web vecchia, mobile, worker, widget, webhook, o funzioni ancora in arrivo).

<details><summary>Elenco</summary>

- `DELETE /api/auth/invites/:token`
- `DELETE /api/automations/:code/draft`
- `DELETE /api/backlog/:id/design`
- `DELETE /api/backlog/:id/plan`
- `DELETE /api/drive/google/folders/:id`
- `DELETE /api/me/calendar/series/:recurringEventId`
- `DELETE /api/repositories/:id/env-files/:fileId`
- `DELETE /api/repositories/:id/env-files/:fileId/vars/:key`
- `DELETE /api/saved-views/:id`
- `DELETE /api/search/history`
- `DELETE /api/search/history/:type/:entityId`
- `DELETE /api/tickets/:id/design`
- `DELETE /api/tickets/:id/plan`
- `DELETE /api/tickets/:id/repositories/:repositoryId/adoption`
- `DELETE /api/users/:id/slack`
- `DELETE /api/vault/users/:userId/device-seals/:id`
- `GET /api/agent-sessions/:id/stream`
- `GET /api/ai-usage/breakdown`
- `GET /api/ai-usage/costs`
- `GET /api/auth/invites`
- `GET /api/automation-origin`
- `GET /api/automation-runs`
- `GET /api/automations/:code/runs/:n`
- `GET /api/backlog`
- `GET /api/backlog/:id`
- `GET /api/backlog/jobs/:jobId`
- `GET /api/briefs/:briefId`
- `GET /api/chat/channels/:id/stream`
- `GET /api/claude/capabilities`
- `GET /api/credentials/:id/recipients`
- `GET /api/drive/files/by-code/:code/content`
- `GET /api/drive/google/links`
- `GET /api/git-accounts/:id`
- `GET /api/git-accounts/:id/branches`
- `GET /api/git-accounts/:id/repositories`
- `GET /api/git-accounts/:id/validate-repo`
- `GET /api/inbox/unread-count`
- `GET /api/me/automation-approvals`
- `GET /api/me/automation-runs`
- `GET /api/me/calendar`
- `GET /api/me/google/callback`
- `GET /api/me/mail`
- `GET /api/me/mail/:source/:id`
- `GET /api/me/mail/rejections`
- `GET /api/me/mail/summary`
- `GET /api/me/notification-prefs`
- `GET /api/milestones/:id`
- `GET /api/openapi.json`
- `GET /api/product-changes`
- `GET /api/product-pages/:id/live`
- `GET /api/projects/:projectId/automations`
- `GET /api/projects/:projectId/briefs`
- `GET /api/projects/:projectId/credentials/recipients`
- `GET /api/projects/:projectId/docs/chat/sessions`
- `GET /api/projects/:projectId/docs/chat/sessions/:id/messages`
- `GET /api/projects/:projectId/docs/highlights`
- `GET /api/projects/:projectId/drive/google/files`
- `GET /api/projects/:projectId/drive/google/folders`
- `GET /api/projects/:projectId/drive/google/links`
- `GET /api/projects/:projectId/email-labels`
- `GET /api/projects/:projectId/email-routes`
- `GET /api/projects/:projectId/reviews`
- `GET /api/projects/:projectId/timeline`
- `GET /api/projects/:projectId/widget/conversations`
- `GET /api/projects/:projectId/widget/conversations/:conversationId/messages`
- `GET /api/projects/archive-candidates`
- `GET /api/projects/pulse`
- `GET /api/repositories`
- `GET /api/repositories/:id/env-files`
- `GET /api/repositories/:id/graph/html`
- `GET /api/repositories/:id/graph/json`
- `GET /api/repositories/:repositoryId/docs/chat/sessions`
- `GET /api/repositories/:repositoryId/docs/chat/sessions/:id/messages`
- `GET /api/repositories/:repositoryId/docs/export`
- `GET /api/repositories/:slug`
- `GET /api/repositories/:slug/webhook`
- `GET /api/roles`
- `GET /api/saved-views`
- `GET /api/search/docs-semantic`
- `GET /api/search/history`
- `GET /api/servers/:id`
- `GET /api/servers/:id/checks`
- `GET /api/servers/:id/operations`
- `GET /api/settings/mail-admission`
- `GET /api/settings/notifications`
- `GET /api/slack/workspace-users`
- `GET /api/tasks/:ticketId/server-fix`
- `GET /api/tickets`
- `GET /api/tickets/:id/activity`
- `GET /api/tickets/:id/history`
- `GET /api/tickets/:id/questions`
- `GET /api/tickets/:ticketId/attachments`
- `GET /api/tickets/:ticketId/comments`
- `GET /api/tickets/:ticketId/jobs`
- `GET /api/tickets/:ticketId/usage`
- `GET /api/users`
- `GET /api/users/:id/avatar`
- `GET /api/vault/keys/mine`
- `GET /api/vault/recovery-key/preview`
- `GET /api/vault/users/:userId/device-seals`
- `PATCH /api/automations/:code`
- `PATCH /api/backlog/:id`
- `PATCH /api/me/notification-prefs`
- `PATCH /api/saved-views/:id`
- `PATCH /api/settings/mail-admission`
- `PATCH /api/tickets/:id`
- `PATCH /api/users/:id/role`
- `POST /api/auth/desktop-exchange`
- `POST /api/auth/mobile-login`
- `POST /api/automations`
- `POST /api/automations/:code/activate`
- `POST /api/automations/:code/check`
- `POST /api/automations/:code/duplicate`
- `POST /api/automations/:code/pause`
- `POST /api/automations/:code/publish`
- `POST /api/automations/:code/runs`
- `POST /api/automations/:code/runs/:n/approve`
- `POST /api/automations/:code/runs/:n/cancel`
- `POST /api/automations/:code/runs/:n/project`
- `POST /api/automations/:code/runs/:n/reject`
- `POST /api/automations/:code/runs/:n/retry`
- `POST /api/automations/:code/runs/:n/skip`
- `POST /api/backlog`
- `POST /api/backlog/:id/convert`
- `POST /api/backlog/:id/merge`
- `POST /api/backlog/:id/suggested/accept`
- `POST /api/backlog/:id/suggested/dismiss`
- `POST /api/backlog/from-design`
- `POST /api/claude/conversations/:id/proposals`
- `POST /api/drive/google/folders/:id/sync`
- `POST /api/inbound/:slug/ticket`
- `POST /api/inbox/:id/actions/:action`
- `POST /api/me/devices/delete`
- `POST /api/product-pages/:id/live/presence`
- `POST /api/product-pages/:id/update-from-source`
- `POST /api/product-pages/:id/wireframes/:blockId/pick`
- `POST /api/product-pages/:id/wireframes/:blockId/undo-draw`
- `POST /api/projects/:projectId/briefs/generate`
- `POST /api/projects/:projectId/drive/google/files`
- `POST /api/projects/:projectId/drive/google/folders`
- `POST /api/repositories`
- `POST /api/repositories/:id/env-files`
- `POST /api/repositories/:id/env-files/:fileId/import`
- `POST /api/repositories/:slug/configure-webhook`
- `POST /api/saved-views`
- `POST /api/search/history`
- `POST /api/settings/notifications/test`
- `POST /api/slack/commands`
- `POST /api/slack/interactions`
- `POST /api/tickets`
- `POST /api/tickets/:id/repositories/:repositoryId/adoption`
- `POST /api/vault/activate`
- `POST /api/vault/device-pairings/lookup`
- `POST /api/vault/device-seals`
- `POST /api/vault/keys`
- `POST /api/vault/keys/:id/seals`
- `POST /api/vault/recovery-key`
- `POST /api/vault/recovery/challenge`
- `POST /api/vault/recovery/confirm/:personKeyId`
- `POST /api/vault/recovery/pending`
- `PUT /api/automations/:code/draft`
- `PUT /api/backlog/:id/design`
- `PUT /api/backlog/:id/plan`
- `PUT /api/drive/files/:id/hidden`
- `PUT /api/me/devices`
- `PUT /api/projects/:projectId/email-routes`
- `PUT /api/repositories/:id/env-files/:fileId/vars/:key`
- `PUT /api/settings/notifications`
- `PUT /api/tickets/:id/design`
- `PUT /api/tickets/:id/plan`
- `PUT /api/users/:id/slack`

</details>

