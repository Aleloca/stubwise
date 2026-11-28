# Rotte del server contro i chiamanti dell'app

Generato da `apps/server/scripts/route-callers.ts`. Rotte: 722; usate dall'app: 539; esterne per dichiarazione: 35; dubbi: 48; **senza chiamanti: 100**.

Base: `712522745`. Un ramo non ancora unito che chiama una rotta (la cassaforte nel browser, il grafo, le PR aperte) qui non si vede: lo script si rilancia sulla base del taglio.

L'MCP non conta come chiamante (D4). Ogni riga è da rivedere a mano prima di togliere la rotta.

Di quelle senza chiamanti, **17 le usano i tool dedicati dell'MCP** (`packages/mcp/src`, compresi i flussi dei comandi del plugin): toglierle rompe quei tool, quindi o il tool passa a una rotta dell'app o la rotta resta. 20 le usa la mobile di oggi (D5: si accetta).

## Senza chiamanti: da togliere (100)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/ai-usage/breakdown` | aiUsage.breakdown |  |
| `POST /api/auth/mobile-login` | — | mobile di oggi |
| `PATCH /api/automation-sources/:id` | automationSources.rename |  |
| `GET /api/automations/:code/runs/:n` | automationRuns.get |  |
| `POST /api/automations/:code/runs/:n/approve` | automationRuns.approve |  |
| `POST /api/automations/:code/runs/:n/cancel` | automationRuns.cancel |  |
| `POST /api/automations/:code/runs/:n/project` | automationRuns.chooseProject |  |
| `POST /api/automations/:code/runs/:n/reject` | automationRuns.reject |  |
| `POST /api/automations/:code/runs/:n/retry` | automationRuns.retry |  |
| `POST /api/automations/:code/runs/:n/skip` | automationRuns.skip |  |
| `GET /api/backlog/:id` | backlog.get | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `PATCH /api/backlog/:id` | backlog.update | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `POST /api/backlog/:id/convert` | backlog.convert | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `DELETE /api/backlog/:id/design` | backlog.deleteDesign | ⚠️ la usano i tool dedicati dell'MCP |
| `PUT /api/backlog/:id/design` | backlog.setDesign | ⚠️ la usano i tool dedicati dell'MCP |
| `POST /api/backlog/:id/merge` | backlog.merge |  |
| `DELETE /api/backlog/:id/plan` | backlog.deletePlan | ⚠️ la usano i tool dedicati dell'MCP |
| `PUT /api/backlog/:id/plan` | backlog.setPlan | ⚠️ la usano i tool dedicati dell'MCP |
| `POST /api/backlog/:id/suggested/accept` | backlog.acceptSuggested |  |
| `POST /api/backlog/:id/suggested/dismiss` | backlog.dismissSuggested |  |
| `POST /api/backlog/from-design` | backlog.createFromDesign | ⚠️ la usano i tool dedicati dell'MCP |
| `GET /api/backlog/jobs/:jobId` | backlog.job | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/chat/search` | chat.search |  |
| `GET /api/git-accounts/:id/branches` | gitAccounts.branches |  |
| `GET /api/git-accounts/:id/repositories` | gitAccounts.repositories |  |
| `GET /api/git-accounts/:id/validate-repo` | gitAccounts.validateRepo |  |
| `POST /api/inbox/:id/actions/:action` | inbox.act | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/mcp/catalog` | mcp.catalog | ⚠️ la usano i tool dedicati dell'MCP |
| `GET /api/mcp/catalog/:action` | mcp.describe | ⚠️ la usano i tool dedicati dell'MCP |
| `GET /api/me/calendar/freebusy` | calendar.freeBusy |  |
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
| `GET /api/releases/search` | releases.search |  |
| `GET /api/repositories/:id/env-files` | repositories.envFiles |  |
| `POST /api/repositories/:id/env-files` | repositories.createEnvFile |  |
| `DELETE /api/repositories/:id/env-files/:fileId` | — |  |
| `POST /api/repositories/:id/env-files/:fileId/import` | — |  |
| `DELETE /api/repositories/:id/env-files/:fileId/vars/:key` | — |  |
| `PUT /api/repositories/:id/env-files/:fileId/vars/:key` | — |  |
| `GET /api/repositories/:id/graph/html` | graph.html |  |
| `GET /api/repositories/:repositoryId/docs/chat/sessions` | docs.chats |  |
| `GET /api/repositories/:repositoryId/docs/chat/sessions/:id/messages` | docs.chatMessages |  |
| `GET /api/repositories/:repositoryId/docs/export` | docs.export |  |
| `POST /api/repositories/:slug/configure-webhook` | repositories.configureWebhook |  |
| `GET /api/repositories/:slug/webhook` | repositories.webhook |  |
| `DELETE /api/saved-views/:id` | savedViews.delete |  |
| `PATCH /api/saved-views/:id` | savedViews.update |  |
| `GET /api/search/docs-semantic` | docs.semanticSearch | mobile di oggi |
| `DELETE /api/search/history/:type/:entityId` | search.forget |  |
| `DELETE /api/servers/:id` | servers.delete |  |
| `GET /api/servers/:id` | servers.get |  |
| `PATCH /api/servers/:id` | servers.update |  |
| `GET /api/servers/:id/operations` | servers.operations |  |
| `GET /api/settings/mail-admission` | settings.mailAdmission |  |
| `PATCH /api/settings/mail-admission` | settings.updateMailAdmission |  |
| `GET /api/settings/notifications` | settings.notifications |  |
| `PUT /api/settings/notifications` | settings.updateNotifications |  |
| `POST /api/settings/notifications/test` | settings.testNotifications |  |
| `GET /api/slack/workspace-users` | slack.workspaceUsers |  |
| `GET /api/tasks/:ticketId/server-fix` | tasks.serverFix |  |
| `POST /api/tasks/:ticketId/server-fix` | tasks.requestServerFix |  |
| `GET /api/tickets/:id/activity` | tickets.activity |  |
| `DELETE /api/tickets/:id/design` | tickets.deleteDesign | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `PUT /api/tickets/:id/design` | tickets.setDesign | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
| `GET /api/tickets/:id/history` | tickets.history | mobile di oggi |
| `DELETE /api/tickets/:id/plan` | tickets.deletePlan | ⚠️ la usano i tool dedicati dell'MCP; mobile di oggi |
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

## Dubbi: il percorso compare nel codice dell'app o in una risposta del server, senza una chiamata tracciata (48)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/ai-usage/costs` | aiUsage.costs | scritto dal server in una risposta |
| `GET /api/attachments/:attachmentId/download` | attachments.download | `apps/desktop/src/renderer/data/backend/real/attachments.ts` |
| `POST /api/auth/desktop-exchange` | — | `apps/desktop/src/main/browserLogin.ts` |
| `GET /api/auth/invites` | auth.invites | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `DELETE /api/auth/invites/:token` | auth.revokeInvite | `apps/desktop/src/renderer/data/backend/real/entry.ts` |
| `GET /api/automations/:code` | automations.get | `apps/desktop/src/renderer/data/backend/real/automationRefs.ts` |
| `PATCH /api/automations/:code` | automations.update | `apps/desktop/src/renderer/data/backend/real/automationRefs.ts` |
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
| `GET /api/me/security` | me.security | `apps/desktop/src/renderer/data/backend/real/meSecurity.ts` |
| `GET /api/product-changes` | productDocs.changes | scritto dal server in una risposta |
| `POST /api/projects/:projectId/docs/chat` | docs.askProject | `apps/desktop/src/renderer/data/backend/real/docs.ts` |
| `GET /api/projects/:projectId/widgets` | widgets.list | scritto dal server in una risposta |
| `POST /api/projects/:projectId/widgets` | widgets.create | scritto dal server in una risposta |
| `GET /api/projects/archive-candidates` | projects.archiveCandidates | scritto dal server in una risposta |
| `GET /api/projects/pulse` | projects.pulse | `apps/desktop/src/renderer/data/backend/real/overview.ts` |
| `GET /api/projects/pulses` | projects.pulses | `apps/desktop/src/renderer/data/backend/real/overview.ts` |
| `POST /api/repositories` | repositories.create | scritto dal server in una risposta |
| `POST /api/repositories/:repositoryId/docs/chat` | docs.askRepository | `apps/desktop/src/renderer/data/backend/real/docs.ts` |
| `GET /api/roles` | roles.list | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `GET /api/saved-views` | savedViews.list | scritto dal server in una risposta |
| `POST /api/saved-views` | savedViews.create | scritto dal server in una risposta |
| `GET /api/search` | search.query | scritto dal server in una risposta |
| `DELETE /api/search/history` | search.clearHistory | scritto dal server in una risposta |
| `GET /api/search/history` | search.history | scritto dal server in una risposta |
| `POST /api/search/history` | search.remember | scritto dal server in una risposta |
| `GET /api/support/conversations/by-code/:code` | support.conversation | scritto dal server in una risposta |
| `GET /api/tickets` | tickets.list | scritto dal server in una risposta |
| `POST /api/tickets` | tickets.create | scritto dal server in una risposta |
| `GET /api/tickets/:id/links` | tickets.links | `apps/desktop/src/renderer/data/backend/real/taskDetail.ts` |
| `GET /api/tickets/:ticketId/attachments` | attachments.list | `apps/desktop/src/renderer/data/backend/real/attachments.ts` |
| `GET /api/tickets/:ticketId/jobs` | tickets.jobs | scritto dal server in una risposta |
| `GET /api/tickets/:ticketId/usage` | tickets.usage | scritto dal server in una risposta |
| `GET /api/users` | users.list | `apps/desktop/src/renderer/data/backend/real/adminPeople.ts` |
| `GET /api/users/:id/avatar` | users.avatar | scritto dal server in una risposta |
| `POST /api/vault/device-pairings` | — | `apps/desktop/src/main/vaultRemote.ts` |
| `POST /api/vault/device-seals` | — | `apps/desktop/src/main/vaultOps.ts` |
| `DELETE /api/vault/device-seals/mine` | — | `apps/desktop/src/main/vaultRemote.ts` |
| `GET /api/vault/device-seals/mine` | — | `apps/desktop/src/main/vaultRemote.ts` |
| `GET /api/vault/users/:userId/device-seals` | — | `apps/desktop/src/renderer/data/backend/real/vaultMacsOf.ts` |

## Esterne per dichiarazione (restano, salvo decisione) (35)

| Rotta | Azione MCP | Note |
|---|---|---|
| `GET /api/agent-sessions/:id/stream` | (exclude: stream) | exclude: stream |
| `GET /api/chat/channels/:id/stream` | (exclude: stream) | exclude: stream |
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
