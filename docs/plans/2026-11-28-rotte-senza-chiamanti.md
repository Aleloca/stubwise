# Rotte del server contro i chiamanti dell'app

Generato da `apps/server/scripts/route-callers.ts`. Rotte: 734; usate dall'app: 598; esterne per dichiarazione: 34; dubbi: 35; **senza chiamanti: 67**.

Base: `152916dfd`. Un ramo non ancora unito che chiama una rotta (la cassaforte nel browser, il grafo, le PR aperte) qui non si vede: lo script si rilancia sulla base del taglio.

L'MCP non conta come chiamante (D4). Ogni riga è da rivedere a mano prima di togliere la rotta.

Di quelle senza chiamanti, **12 le usano i tool dedicati dell'MCP** (`packages/mcp/src`, compresi i flussi dei comandi del plugin): toglierle rompe quei tool, quindi o il tool passa a una rotta dell'app o la rotta resta. 17 le usa la mobile di oggi (D5: si accetta).

## Revisione a mano (28 nov 2026, secondo giro)

Lo script è stato corretto per sei classi di falsi negativi. Le prime due le aveva trovate 79, le altre sono venute fuori dalla revisione:

1. un segmento variabile alla fine del percorso (`` request("DELETE", `/api/tickets/${id}/${field}`) ``): un segmento variabile di una chiamata COL VERBO vale qualunque segmento della rotta, ma solo se nessuna rotta con quel verbo ha esattamente quel percorso (`/api/projects/${id}` è `/:projectId`, non `/pulse`). Le rotte raggiunte solo così hanno una sezione a sé;
2. una funzione della fabbrica definita fuori dall'oggetto e messa dentro (`act` dell'inbox, e `answer` che la chiama);
3. un aiuto costruito su un altro (`` const run = (c, n) => `${base(c)}/runs/${n}` ``): le decisioni sulle esecuzioni delle automazioni;
4. un aiuto passato nudo come percorso (`request("GET", base(code))`, `request("GET", SECURITY)`): server, automazioni, widget, `server-fix`;
5. una funzione col verbo che non si chiama `request` (`one(…)` dell'api-client, `call(…)` del main del Mac, `this.http(…)` della cassaforte nel browser) o con un generico (`request<…>(`);
6. le virgolette dentro un'interpolazione (`${toQuery({ ids: ids.join(",") })}`), che troncavano il percorso: `freeBusy`, la ricerca della chat, quella dei rilasci, lo zip dei Docs.

Da 100 senza chiamanti (primo giro, base `712522745`) a **67** (base `152916dfd`, con #137, #141 e #145 in main). Le 67, una per una:

- **2 in arrivo** da rami non uniti:
  - `DELETE /api/search/history/:type/:entityId` (#138);
  - `GET /api/vault/keys/mine` (`feat/cassaforte-browser`, 79).
- **9 della cassaforte nel browser, ancora senza chiamante** (inventario §1.2, il lavoro di 79): `POST /api/vault/activate`, `POST /api/vault/keys`, `POST /api/vault/keys/:id/seals`, `GET /api/vault/recovery-key/preview`, `POST /api/vault/recovery-key`, `POST /api/vault/recovery/challenge`, `POST /api/vault/recovery/pending`, `POST /api/vault/recovery/confirm/:personKeyId`, `POST /api/vault/device-pairings/lookup`. Oggi le chiama solo il web vecchio (creare la chiave, kit di recupero, recupero, attivare l'istanza, la pagina che conferma l'accoppiamento del Mac), e `feat/cassaforte-browser` non le chiama ancora. **NON si tolgono**: sono la funzione che la nuova app deve ancora avere. Da confermare con 79 quali entrano nel suo ramo.
- **16 del gruppo (e)**, già deciso: viste salvate (2), Slack (3), posta ammessa (2), regole della posta del progetto (`email-routes` 2, `email-labels` 1), «Rigenera il brief» (1), adozione (2), webhook unico delle notifiche (3).
- **12 dei tool dedicati dell'MCP** (blocco P, D10): `GET`/`PATCH /api/backlog/:id`, `POST …/convert`, `PUT …/design` e `…/plan` di backlog e ticket, `POST /api/backlog/from-design`, `GET /api/backlog/jobs/:jobId`, `GET /api/projects/:projectId/briefs`, e `GET /api/mcp/catalog` e `…/:action`. Il catalogo **resta**: è l'infrastruttura dell'MCP. Le quattro `DELETE …/design|plan` non ci sono più: la nuova app le chiama («Remove design», «Remove plan»).
- **9 solo della mobile di oggi** (D5, si accetta): `POST /api/auth/mobile-login`, `PUT /api/me/devices`, `POST /api/me/devices/delete`, `GET /api/me/mail/:source/:id`, `GET /api/me/mail/rejections`, `GET /api/projects/:projectId/docs/highlights`, `GET /api/search/docs-semantic`, `GET /api/tickets/:id/history`, `GET /api/tickets/:id/questions`. La mobile usa anche l'adozione, già nel gruppo (e).
- **2 dei Docs di prodotto toccati da Claude**: `POST /api/product-pages/:id/update-from-source` e `POST /api/product-pages/:id/wireframes/:blockId/undo-draw` (area 11, F6). Il web vecchio non le ha. Nell'app le fa Claude dal pannello, che chiama i servizi e non le rotte. L'MCP le espone per la parità (lotto 4). **Proposta: restano**, perché sono la forma su rotta di un'azione che l'app fa.
- **17 da togliere: il web vecchio e basta.** Per ognuna, o la funzione nell'app c'è con un'altra rotta (inventario §1, «a»), o era già morta nel web:

  | Rotta | Al suo posto |
  |---|---|
  | `GET /api/ai-usage/breakdown` | `summary` e `snapshots` |
  | `POST /api/backlog/:id/merge` | `POST /api/requests/:id/merge` |
  | `POST /api/backlog/:id/suggested/accept`, `…/dismiss` | `/api/requests/:id/suggestions/*` |
  | `GET /api/me/mail/summary` | thread e proposte |
  | `GET /api/projects/:projectId/docs/chat/sessions` e `…/:id/messages` | morte anche nel web (`getDocChatSessions`) |
  | `GET /api/repositories/:repositoryId/docs/chat/sessions` e `…/:id/messages` | come sopra |
  | `GET /api/projects/:projectId/reviews` | morta anche nel web (`getProjectReviews`) |
  | `GET /api/projects/:projectId/timeline` | `projects.chronology`. Il modulo `project-timeline.ts` resta: lo usa il brief settimanale |
  | `GET /api/projects/:projectId/widget/conversations` e `…/:conversationId/messages` | `/api/support/*` |
  | `GET /api/repositories/:slug/webhook` | lo stato viene da `webhookConfiguredAt` del repository (#137) |
  | `GET /api/servers/:id/operations` | monitor e server dell'app (inventario §1, «a»): nessun chiamante, né nel web né nell'app |
  | `GET /api/tickets/:id/activity` | `GET /api/tasks/:id/activity` |
  | `PATCH /api/users/:id/role` | `PATCH /api/users/:id/instance-role` |

  Nessuna delle 17 la usano la mobile o i tool dedicati dell'MCP. Le azioni MCP che il catalogo ne deriva spariscono con loro, come vuole D4.

## Senza chiamanti: da togliere (67)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/ai-usage/breakdown` | aiUsage.breakdown |  |
| `POST /api/auth/mobile-login` | — | mobile di oggi |
| `GET /api/backlog/:id` | backlog.get | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `PATCH /api/backlog/:id` | backlog.update | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `POST /api/backlog/:id/convert` | backlog.convert | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `PUT /api/backlog/:id/design` | backlog.setDesign | ⚠️ la usano i tool dedicati dell'MCP |
| `POST /api/backlog/:id/merge` | backlog.merge |  |
| `PUT /api/backlog/:id/plan` | backlog.setPlan | ⚠️ la usano i tool dedicati dell'MCP |
| `POST /api/backlog/:id/suggested/accept` | backlog.acceptSuggested |  |
| `POST /api/backlog/:id/suggested/dismiss` | backlog.dismissSuggested |  |
| `POST /api/backlog/from-design` | backlog.createFromDesign | ⚠️ la usano i tool dedicati dell'MCP |
| `GET /api/backlog/jobs/:jobId` | backlog.job | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/mcp/catalog` | mcp.catalog | ⚠️ la usano i tool dedicati dell'MCP |
| `GET /api/mcp/catalog/:action` | mcp.describe | ⚠️ la usano i tool dedicati dell'MCP |
| `PUT /api/me/devices` | (exclude: app_only) | mobile di oggi |
| `POST /api/me/devices/delete` | me.unregisterDevice | mobile di oggi |
| `GET /api/me/mail/:source/:id` | mail.message | mobile di oggi |
| `GET /api/me/mail/rejections` | mail.rejections | mobile di oggi |
| `GET /api/me/mail/summary` | mail.summary |  |
| `POST /api/product-pages/:id/update-from-source` | productDocs.updateFromSource |  |
| `POST /api/product-pages/:id/wireframes/:blockId/undo-draw` | productDocs.undoWireframe |  |
| `GET /api/projects/:projectId/briefs` | projects.briefs | ⚠️ la usano i tool dedicati dell'MCP |
| `POST /api/projects/:projectId/briefs/generate` | projects.generateBrief |  |
| `GET /api/projects/:projectId/docs/chat/sessions` | docs.projectChats |  |
| `GET /api/projects/:projectId/docs/chat/sessions/:id/messages` | docs.projectChatMessages |  |
| `GET /api/projects/:projectId/docs/highlights` | docs.projectHighlights | mobile di oggi |
| `GET /api/projects/:projectId/email-labels` | projects.emailLabels |  |
| `GET /api/projects/:projectId/email-routes` | projects.emailRoutes |  |
| `PUT /api/projects/:projectId/email-routes` | projects.setEmailRoutes |  |
| `GET /api/projects/:projectId/reviews` | projects.reviews |  |
| `GET /api/projects/:projectId/timeline` | projects.timeline |  |
| `GET /api/projects/:projectId/widget/conversations` | widgets.conversations |  |
| `GET /api/projects/:projectId/widget/conversations/:conversationId/messages` | widgets.conversation |  |
| `GET /api/repositories/:repositoryId/docs/chat/sessions` | docs.chats |  |
| `GET /api/repositories/:repositoryId/docs/chat/sessions/:id/messages` | docs.chatMessages |  |
| `GET /api/repositories/:slug/webhook` | repositories.webhook |  |
| `DELETE /api/saved-views/:id` | savedViews.delete |  |
| `PATCH /api/saved-views/:id` | savedViews.update |  |
| `GET /api/search/docs-semantic` | docs.semanticSearch | mobile di oggi |
| `DELETE /api/search/history/:type/:entityId` | search.forget |  |
| `GET /api/servers/:id/operations` | servers.operations |  |
| `GET /api/settings/mail-admission` | settings.mailAdmission |  |
| `PATCH /api/settings/mail-admission` | settings.updateMailAdmission |  |
| `GET /api/settings/notifications` | settings.notifications |  |
| `PUT /api/settings/notifications` | settings.updateNotifications |  |
| `POST /api/settings/notifications/test` | settings.testNotifications |  |
| `GET /api/slack/workspace-users` | slack.workspaceUsers |  |
| `GET /api/tickets/:id/activity` | tickets.activity |  |
| `PUT /api/tickets/:id/design` | tickets.setDesign | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/tickets/:id/history` | tickets.history | mobile di oggi |
| `PUT /api/tickets/:id/plan` | tickets.setPlan | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/tickets/:id/questions` | tickets.questions | mobile di oggi |
| `DELETE /api/tickets/:id/repositories/:repositoryId/adoption` | pulls.releaseAdoption | mobile di oggi |
| `POST /api/tickets/:id/repositories/:repositoryId/adoption` | pulls.adopt | mobile di oggi |
| `PATCH /api/users/:id/role` | — |  |
| `DELETE /api/users/:id/slack` | — |  |
| `PUT /api/users/:id/slack` | — |  |
| `POST /api/vault/activate` | — |  |
| `POST /api/vault/device-pairings/lookup` | — |  |
| `POST /api/vault/keys` | — |  |
| `POST /api/vault/keys/:id/seals` | — |  |
| `GET /api/vault/keys/mine` | — |  |
| `POST /api/vault/recovery-key` | — |  |
| `GET /api/vault/recovery-key/preview` | — |  |
| `POST /api/vault/recovery/challenge` | — |  |
| `POST /api/vault/recovery/confirm/:personKeyId` | — |  |
| `POST /api/vault/recovery/pending` | — |  |

## Dubbi: il percorso compare nel codice dell'app o in una risposta del server, senza una chiamata tracciata (35)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/ai-usage/costs` | aiUsage.costs | scritto dal server in una risposta |
| `GET /api/attachments/:attachmentId/download` | attachments.download | `apps/desktop/src/renderer/data/backend/real/attachments.ts` |
| `POST /api/auth/desktop-exchange` | — | `apps/desktop/src/main/browserLogin.ts` |
| `GET /api/auth/invites` | auth.invites | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `DELETE /api/auth/invites/:token` | auth.revokeInvite | `apps/desktop/src/renderer/data/backend/real/entry.ts` |
| `GET /api/backlog` | backlog.list | scritto dal server in una risposta |
| `POST /api/backlog` | backlog.create | scritto dal server in una risposta |
| `GET /api/claude/capabilities` | claude.capabilities | scritto dal server in una risposta |
| `GET /api/drive/files/by-code/:code/content` | drive.content | scritto dal server in una risposta |
| `GET /api/me/calendar` | calendar.list | scritto dal server in una risposta |
| `GET /api/me/mail` | mail.list | scritto dal server in una risposta |
| `POST /api/me/mail/drafts/:id/attachments` | mail.attachFile | `apps/desktop/src/renderer/data/backend/real/mailDrafts.ts` |
| `POST /api/me/mail/drafts/claude` | mail.claudeDraft | `apps/desktop/src/renderer/data/backend/real/mailClaudeDraft.ts`, `apps/desktop/src/main/apiStream.ts` |
| `GET /api/me/notification-prefs` | me.notificationPrefs | scritto dal server in una risposta |
| `PATCH /api/me/notification-prefs` | me.updateNotificationPrefs | scritto dal server in una risposta |
| `GET /api/product-changes` | productDocs.changes | scritto dal server in una risposta |
| `POST /api/projects/:projectId/docs/chat` | docs.askProject | `apps/desktop/src/renderer/data/backend/real/docs.ts` |
| `GET /api/projects/archive-candidates` | projects.archiveCandidates | scritto dal server in una risposta |
| `GET /api/projects/pulse` | projects.pulse | `apps/desktop/src/renderer/data/backend/real/overview.ts` |
| `GET /api/repositories/:id/graph/html` | graph.html | `apps/desktop/src/renderer/platform/graphFrame.ts` |
| `POST /api/repositories/:repositoryId/docs/chat` | docs.askRepository | `apps/desktop/src/renderer/data/backend/real/docs.ts` |
| `GET /api/roles` | roles.list | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `GET /api/saved-views` | savedViews.list | scritto dal server in una risposta |
| `POST /api/saved-views` | savedViews.create | scritto dal server in una risposta |
| `DELETE /api/search/history` | search.clearHistory | scritto dal server in una risposta |
| `GET /api/search/history` | search.history | scritto dal server in una risposta |
| `POST /api/search/history` | search.remember | scritto dal server in una risposta |
| `GET /api/tickets` | tickets.list | scritto dal server in una risposta |
| `POST /api/tickets` | tickets.create | scritto dal server in una risposta |
| `GET /api/tickets/:ticketId/attachments` | attachments.list | `apps/desktop/src/renderer/data/backend/real/attachments.ts` |
| `GET /api/tickets/:ticketId/jobs` | tickets.jobs | scritto dal server in una risposta |
| `GET /api/tickets/:ticketId/usage` | tickets.usage | scritto dal server in una risposta |
| `GET /api/users` | users.list | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `GET /api/users/:id/avatar` | users.avatar | scritto dal server in una risposta |
| `POST /api/vault/device-seals` | — | `apps/desktop/src/main/vaultOps.ts` |

## Usate solo attraverso un segmento variabile (`…/${field}`): da confermare che la chiamata le raggiunga (4)

| Rotta | Azione MCP | Note |
|---|---|---|
| `DELETE /api/backlog/:id/design` | backlog.deleteDesign | `apps/desktop/src/renderer/data/backend/real/requests.ts` |
| `DELETE /api/backlog/:id/plan` | backlog.deletePlan | `apps/desktop/src/renderer/data/backend/real/requests.ts` |
| `DELETE /api/tickets/:id/design` | tickets.deleteDesign | `apps/desktop/src/renderer/data/backend/real/taskDesign.ts` |
| `DELETE /api/tickets/:id/plan` | tickets.deletePlan | `apps/desktop/src/renderer/data/backend/real/taskDesign.ts` |

## Esterne per dichiarazione (restano, salvo decisione) (34)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/agent-sessions/:id/stream` | (exclude: stream) | exclude: stream |
| `GET /api/credentials/:id/recipients` | (exclude: vault) | exclude: vault |
| `POST /api/inbound/:slug/ticket` | (exclude: inbound) | exclude: inbound |
| `GET /api/me/google/callback` | (exclude: inbound) | exclude: inbound |
| `GET /api/openapi.json` | (exclude: infra) | exclude: infra |
| `GET /api/product-pages/:id/live` | (exclude: stream) | exclude: stream |
| `GET /api/projects/:projectId/credentials/recipients` | (exclude: vault) | exclude: vault |
| `POST /api/slack/commands` | (exclude: inbound) | exclude: inbound |
| `POST /api/slack/interactions` | (exclude: inbound) | exclude: inbound |
| `GET /go/agents/job/:jobId` | (exclude: infra) | exclude: infra |
| `GET /go/backlog` | (exclude: infra) | exclude: infra |
| `GET /go/backlog/:id` | (exclude: infra) | exclude: infra |
| `GET /go/docs/:repositoryId` | (exclude: infra) | exclude: infra |
| `GET /go/docs/:repositoryId/:slug` | (exclude: infra) | exclude: infra |
| `GET /go/monitor/servers/:id` | (exclude: infra) | exclude: infra |
| `GET /go/projects/:id` | (exclude: infra) | exclude: infra |
| `GET /go/projects/:id/backlog` | (exclude: infra) | exclude: infra |
| `GET /go/projects/:id/roadmap` | (exclude: infra) | exclude: infra |
| `GET /go/tickets/:id` | (exclude: infra) | exclude: infra |
| `GET /health` | (exclude: infra) | exclude: infra |
| `POST /ingest/:slug` | (exclude: inbound) | exclude: inbound |
| `GET /monitor/commands` | (exclude: inbound) | exclude: inbound |
| `POST /monitor/commands/:commandId/result` | (exclude: inbound) | exclude: inbound |
| `GET /monitor/config` | (exclude: inbound) | exclude: inbound |
| `POST /monitor/ingest` | (exclude: inbound) | exclude: inbound |
| `POST /webhooks/git/:projectSlug` | (exclude: inbound) | exclude: inbound |
| `POST /webhooks/in/:secret` | (exclude: inbound) | exclude: inbound |
| `GET /widget/:slug/config` | (exclude: inbound) | exclude: inbound |
| `POST /widget/:slug/conversations` | (exclude: inbound) | exclude: inbound |
| `GET /widget/:slug/conversations/:conversationId/messages` | (exclude: inbound) | exclude: inbound |
| `POST /widget/:slug/conversations/:conversationId/messages` | (exclude: inbound) | exclude: inbound |
| `POST /widget/:slug/conversations/:conversationId/tickets` | (exclude: inbound) | exclude: inbound |
| `GET /widget/:slug/me/requests` | (exclude: inbound) | exclude: inbound |
| `GET /widget/:slug/me/requests/:code` | (exclude: inbound) | exclude: inbound |
