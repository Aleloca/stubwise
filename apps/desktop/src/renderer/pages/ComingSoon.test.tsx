import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth as fakeAuth } from "../data/api";
import { renderRoute } from "../test/renderRoute";
import { closeGoogleAccount } from "./drive/GoogleAccountCard";
import { REPLY_UNDO_MS } from "./support/replyStore";

// Le aree non integrate nella build app (integrazione area 2, fetta 1): restano
// nella navigazione con «Coming soon» e non leggono niente. Nei test il livello
// dati è il finto anche con `VITE_STUBWISE_BUILD=app`: qui si registra ogni
// chiamata ai namespace delle aree future, che devono restare a zero.
const { FUTURE_NAMESPACES, calls, truncated, intake, refusal } = vi.hoisted(() => ({
  // L'intake del server può fondere una richiesta nuova in una esistente: qui la si finge.
  intake: { mergeInto: null as string | null, pending: false },
  // Un rifiuto del server per codice (`{ code }` come un ApiError): la funzione indicata rifiuta così.
  refusal: { fn: null as string | null, code: "" },
  calls: [] as string[],
  // Il finto non tronca mai: qui si finge la risposta del server oltre le 2000 righe.
  truncated: { value: false, onlyFiltered: false },
  FUTURE_NAMESPACES: [
    "auth",
    "admin",
    "me",
    "projectSettings",
  "chat",
  "docs",
  "productDocs",
  "drive",
  "mail",
  "calendar",
  "automations",
  "alerts",
  "releases",
  "support",
  "servers",
  "changelog",
  "access",
  "claude",
  "instance",
  ] as const,
}));

vi.mock("@backend/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const record = (name: string, fn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push(name);
      if (refusal.fn === name) {
        refusal.fn = null;
        return Promise.reject(Object.assign(new Error("Refused by the server"), { code: refusal.code }));
      }
      return fn(...args);
    };
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (name === "createRequest") {
      const create = value as (input: { projectId: string }) => Promise<unknown>;
      const list = mod.listRequests as (projectId: string) => Promise<{ code: string }[]>;
      wrapped[name] = record(name, async (...args: unknown[]) => {
        const input = args[0] as { projectId: string };
        // Accodata dal server ma senza esito ancora (`intake_pending`, review della fetta 4).
        if (intake.pending) throw new Error("intake_pending");
        if (!intake.mergeInto) return create(input);
        const target = (await list(input.projectId)).find((r) => r.code === intake.mergeInto);
        return { ...target, landedByMerge: true };
      });
    } else if (name === "tasksTruncated") {
      // `onlyFiltered`: troncata solo una lettura con criteri (la vasca del Planning), non quella intera.
      wrapped[name] = record(name, (criteria?: unknown) =>
        truncated.onlyFiltered ? criteria !== undefined : truncated.value,
      );
    } else if (typeof value === "function") {
      wrapped[name] = record(name, value as (...a: unknown[]) => unknown);
    } else if (value && typeof value === "object" && FUTURE_NAMESPACES.includes(name as never)) {
      wrapped[name] = new Proxy(value as Record<string, unknown>, {
        get(t, key) {
          const v = t[key as string];
          if (typeof key !== "string" || typeof v !== "function") return v;
          return record(`${name}.${key}`, v as (...a: unknown[]) => unknown);
        },
      });
    } else wrapped[name] = value;
  }
  return wrapped;
});

const { failNext, resetApi, setLatency } = await import("../data/api");
const { setSessionPersonId } = await import("../data/session");

/** Nella build app la persona è quella della sessione (il finto), non quella di `renderRoute`. */
function signedInAs(personId: string) {
  setSessionPersonId(personId);
}

beforeEach(() => {
  setLatency(0);
  calls.length = 0;
  truncated.value = false;
  truncated.onlyFiltered = false;
  intake.mergeInto = null;
  intake.pending = false;
  refusal.fn = null;
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

/**
 * Ciò che la build app può chiamare: le esportazioni che i Task 16–17
 * dell'integrazione implementano sul server vero (ossatura e Tasks). Ogni
 * altra chiamata, nella build app vera, sarebbe uno stub «non integrato».
 */
const INTEGRATED_CALLS = new Set([
  // Area 9, F1, R4a: Preferenze → Account.
  "me.getMyProfile",
  "me.updateProfile",
  "me.requestEmailChange",
  "me.cancelEmailChange",
  "me.getEmailChangeLink",
  "me.confirmEmailChange",
  "me.changePassword",
  // Area 9, F1, R4b: Preferenze → Security.
  "me.getMySecurity",
  "me.endSession",
  "me.startTotpSetup",
  "me.confirmTotp",
  "me.regenerateBackupCodes",
  "me.addPasskey",
  "me.renamePasskey",
  "me.removePasskey",
  // Area 9, F1, R7: People, inviti e Roles.
  "admin.listPeople",
  "admin.getPerson",
  "admin.listSecurityEvents",
  "admin.listObservedAuthors",
  "admin.setInstanceRole",
  "admin.createPasswordResetLink",
  "admin.resetSecondFactor",
  "admin.deactivatePerson",
  "admin.reactivatePerson",
  "admin.changeEmail",
  "admin.linkGitIdentity",
  "admin.unlinkGitIdentity",
  "admin.setBitbucketUsername",
  "admin.listInvites",
  "admin.getInviteChoices",
  "admin.createInvite",
  "admin.revokeInvite",
  "admin.listRoles",
  "admin.createRole",
  "admin.duplicateRole",
  "admin.updateRole",
  "admin.deleteRole",
  "admin.viewerLosesIf",
  // Area 9, F3: AI → Providers.
  "instance.listProviders",
  "instance.createProvider",
  "instance.renameProvider",
  "instance.setProviderEnabled",
  "instance.moveProvider",
  "instance.testProvider",
  "instance.replaceProviderCredential",
  "instance.deleteProvider",
  // Area 9, F3: Storage.
  "instance.getStorage",
  "instance.saveStorage",
  // Area 9, F3: Plugins.
  "instance.listPlugins",
  "instance.getPlugin",
  "instance.registerPlugin",
  "instance.updatePluginRef",
  "instance.rerunSmoke",
  "instance.removePlugin",
  // Area 9, F3: Git accounts.
  "instance.listGitAccounts",
  "instance.createGitAccount",
  "instance.updateGitAccount",
  "instance.replaceGitToken",
  "instance.validateGitAccount",
  "instance.setDefaultReviewer",
  "instance.deleteGitAccount",
  // Area 9, F3: Google Workspace.
  "instance.listGoogleApps",
  "instance.getGoogleRedirectUri",
  "instance.createGoogleApp",
  "instance.updateGoogleApp",
  "instance.replaceGoogleSecret",
  "instance.deleteGoogleApp",
  // Area 9, F4: la pausa della coda fuori dallo Stato.
  "instance.getQueuePause",
  // Area 9, F5: Integration (lettura e le due rigenerazioni).
  "projectSettings.getIntegration",
  "projectSettings.regenerateIngestionKey",
  "projectSettings.regenerateWebhookSecret",
  // Area 9, F4: Instance status.
  "instance.getInstanceStatus",
  "instance.pauseQueue",
  "instance.resumeQueue",
  "instance.retryJob",
  // Area 9, F4: AI → Usage.
  "instance.getUsage",
  // Area 9, F4: AI → Budget & language.
  "instance.getBudget",
  "instance.saveBudget",
  // Area 9, F3: AI → Models.
  "instance.listModels",
  "instance.setModel",
  // Area 9, F3: AI → Automation.
  "instance.getAutomation",
  "instance.saveAutomation",
  // Area 9, F3: i webhook in uscita.
  "instance.listWebhooks",
  "instance.getWebhook",
  "instance.createWebhook",
  "instance.updateWebhook",
  "instance.regenerateWebhookSecret",
  "instance.deleteWebhook",
  "instance.testWebhook",
  "instance.previewWebhook",
  // Area 9, F2: il registro delle modifiche.
  "changelog.listChangesPage",
  "changelog.listProjectChangesPage",
  "changelog.listChangeFilterChoices",
  // Area 9, F1, R8: Members.
  "admin.listProjectMembers",
  "admin.previewMember",
  "admin.saveMember",
  "admin.addMember",
  "admin.setMemberRole",
  "admin.removeMember",
  "admin.grantMemberPermission",
  "admin.revokeMemberPermission",
  // Area 9, F1, R9: «Chi può farlo?».
  "access.whoCan",
  "access.whatCan",
  "access.whoCanChoices",
  // Area 9, F1, R5: le pagine d'ingresso della web «app».
  "auth.getResetLink",
  "auth.resetPassword",
  "auth.createFirstAdmin",
  "auth.getInvite",
  "auth.register",
  // Area 9, F1, R4c: Tokens e Claude Code.
  "me.listTokens",
  "me.createToken",
  "me.revokeToken",
  "me.createClaudeCodeCommand",
  // Task 16: sessione, persone, progetti, notifiche, ricerca, reparti.
  "getViewer",
  "getSessionPerson",
  "auth.readEntry",
  "auth.login",
  "auth.logout",
  "listPeople",
  "listDepartments",
  "listProjects",
  "getProjectByCode",
  "listPinnedProjectIds",
  "setPinned",
  "listWaitingOnMeProjectIds",
  "listNotifications",
  "markNotification",
  "search",
  "admin.listDepartments",
  // Le persone attive accanto a «People» nella colonna dell'Amministrazione (reali dalla fetta 1).
  "admin.listPeople",
  "admin.createDepartment",
  "admin.updateDepartment",
  "admin.saveDepartment",
  "admin.deleteDepartment",
  // Task 17: Tasks, dettaglio, nuova task, stati.
  "listTasks",
  "listStalled",
  "getTaskByCode",
  "listActivity",
  "listDecisionRequests",
  "getTaskWork",
  "getTaskWorkSummary",
  "listProjectStatuses",
  "listMilestones",
  "getRequest",
  // Fetta 2: settimana, Planning, La mia settimana, Timeline.
  "listDayArrangements",
  "planTask",
  "setDay",
  "tasksTruncated",
  // Fetta 3: Home a blocchi, ruoli di reparto, filtri salvati, richieste da trasformare.
  "listDepartmentHomes",
  "getPersonalHome",
  "setPersonalHome",
  "resetPersonalHome",
  "setDepartmentHome",
  "markDepartmentHomeSeen",
  "listDepartmentRoles",
  "listSavedFilters",
  "getSavedFilter",
  "listPinnedFilterIds",
  "saveFilter",
  "updateFilter",
  "deleteFilter",
  "setFilterPinned",
  "listRequestsToConvert",
  // Fetta 4: Requests, Overview, traguardi, Tutti i progetti, Nuovo progetto.
  "listRequests",
  "getRequestByCode",
  "createRequest",
  "updateRequest",
  "mergeRequest",
  "archiveRequest",
  "reopenRequest",
  "restoreRequest",
  "convertRequest",
  "createMilestone",
  "updateMilestone",
  "deleteMilestone",
  "listDecisionLog",
  "decisionLogTruncated",
  // Area 3, fetta 3a: le sessioni di lavoro in lettura e lo stream dal vivo.
  "listConversations",
  "getConversation",
  "subscribe",
  "mergeStreamEvent",
  "reconnectDelay",
  "onConversationChange",
  // Area 3, fetta 3b: le azioni e «Da decidere» di Claude.
  "startRun",
  "relaunchWithInstructions",
  "resumeCorrection",
  "requestChanges",
  "cancelRun",
  "decidePlan",
  "preApprovePlan",
  "revokePlanApproval",
  "answerQuestion",
  "sendMessage",
  "stop",
  "stopAndSend",
  "listClaudeDecisions",
  // Area 3, fetta 3d: «By person» di Activity.
  "listPeopleActivity",
  // Area 3, fetta 3c: il refinement delle richieste.
  "getRefineOf",
  "startRefineConversation",
  "closeRefine",
  "listDailyReports",
  "generateDailyReport",
  "recordDecision",
  "setDecisionSuperseded",
  "getLatestBrief",
  "listTimelinePage",
  "listPortfolioActivityPage",
  "projectPulse",
  "listProjectPulses",
  "createProject",
  // Chat, fette 1–2 (F1.x, F2.1a): i codici e le citazioni risolti nei
  // messaggi, e il blocco dell'istanza (budget) che spegne la casella.
  "resolveCodes",
  "resolveCitations",
  "instance.getAiBlock",
  // F3.0 della chat: «Delete task…» (l'anteprima si legge all'apertura del menu).
  "getTaskDeletion",
  "deleteTask",
  // Area 4, fetta 1: la Chat fra persone (DM, ricerca, domande, @Claude ed eventi restano fuori).
  "chat.listChannels",
  "chat.getChannel",
  "chat.listChannelMembers",
  "chat.listMessages",
  "chat.getMessage",
  "chat.listThread",
  "chat.listThreadsWithNews",
  "chat.hasNews",
  "chat.listMentions",
  "chat.sendMessage",
  "chat.editMessage",
  "chat.deleteMessage",
  "chat.toggleReaction",
  "chat.markRead",
  "chat.markThreadRead",
  "chat.setThreadFollow",
  "chat.setNotifyLevel",
  "chat.joinChannel",
  "chat.leaveChannel",
  "chat.createChannel",
  "chat.updateChannel",
  "chat.archiveChannel",
  "chat.deleteChannel",
  "chat.channelStream",
  "chat.threadStream",
  "chat.subscribeChat",
  "chat.onChatChange",
  // Area 4, fetta 2.
  "chat.openDm",
  "chat.inviteMembers",
  "chat.removeMember",
  "chat.listQuestions",
  "chat.dismissQuestion",
  "chat.searchChat",
  "chat.createTaskFromMessage",
  "chat.createRequestFromMessage",
  // Area 4, fetta 3: @Claude nei canali.
  "chat.stopClaudeReply",
  "chat.retryClaudeReply",
  "chat.answerChatClaudeQuestion",
  "chat.listClaudeQuestions",
  "chat.confirmChatProposal",
  "chat.cancelChatProposal",
  "chat.editChatProposal",
  // Area 4, fetta 4: eventi dei progetti e allegati.
  "chat.setPublishedEvents",
  "chat.downloadAttachment",
  // Area 5, fetta 2: il Drive dei caricati.
  "drive.listDriveFiles",
  "drive.getDriveFile",
  "drive.searchDrive",
  "drive.uploadFiles",
  "drive.deleteDriveFile",
  "drive.recordOpen",
  "drive.saveAttachmentToDrive",
  // Area 6, fetta 1: il cassetto Google (account e caselle).
  "drive.getGoogleAccount",
  // Area 6, F5b: Google Drive nel Drive dei progetti.
  "drive.listGoogleFiles",
  "drive.listGoogleOutside",
  "drive.listGoogleFolders",
  "drive.listFolderLinks",
  "drive.listMyFolderLinks",
  "drive.addGoogleFile",
  "drive.linkFolder",
  "drive.syncFolder",
  "drive.unlinkFolder",
  "drive.removeGoogleFile",
  "drive.setHidden",
  "drive.listGoogleWorkspaces",
  "drive.connectGoogle",
  "drive.disconnectGoogle",
  // Area 6, fetta 1: la Posta in lettura, le proposte della casella, «Aggiorna ora»,
  // letto / non letto (`data/backend/real/{mail,mailProposals}.ts`).
  "mail.listMailboxes",
  "mail.setProposalsEnabled",
  "mail.syncMailbox",
  "mail.whenMailSynced",
  "mail.whenMailIdle",
  "mail.listMailThreads",
  // Area 6, fetta 2: «Importanti» e il blocco Home «Posta importante».
  "mail.listImportantMail",
  // Area 8: «Clienti in attesa» della Home, dalla posta delle mie caselle.
  "mail.listWaitingCustomers",
  "mail.getMailThread",
  "mail.searchMail",
  "mail.reproposeMessage",
  "mail.markRead",
  "mail.markUnread",
  "mail.listMailProposals",
  "mail.getMailProposal",
  "mail.listMailDecisions",
  "mail.confirmMailProposal",
  "mail.ignoreMailProposal",
  "mail.handMailProposal",
  "mail.reassignMailProposal",
  // Area 6, fetta 2: «Quale progetto?».
  "mail.chooseProjectFor",
  // Area 6, fetta 3: scrivere (`data/backend/real/{mailDrafts,mailSend}.ts`).
  "mail.MAIL_UNDO_MS",
  "mail.MAIL_MAX_ATTACHMENTS",
  "mail.MAIL_MAX_BYTES",
  "mail.listDrafts",
  "mail.getDraft",
  "mail.saveDraft",
  "mail.discardDraft",
  "mail.restoreDiscardedDraft",
  "mail.attachDriveFile",
  "mail.suggestRecipients",
  "mail.sendDraft",
  "mail.whenSendSettled",
  "mail.undoSend",
  "mail.retrySend",
  "mail.deleteFailedSend",
  "mail.streamClaudeDraft",
  // Area 6, fetta 1: il Calendario in lettura e le serie (`data/backend/real/calendar.ts`).
  "calendar.calendarWindow",
  "calendar.spanOf",
  "calendar.listEvents",
  "calendar.getEvent",
  "calendar.listSeries",
  "calendar.listCalendars",
  "calendar.listUpcomingEvents",
  "calendar.configureSeries",
  "calendar.syncCalendar",
  "calendar.whenCalendarIdle",
  // Area 6, F4: la scrittura (review F4, minori).
  "calendar.createEvent",
  "calendar.updateEvent",
  "calendar.moveEvent",
  "calendar.deleteEvent",
  "calendar.respond",
  "calendar.setEventProject",
  "calendar.retrySave",
  "calendar.revertEvent",
  "calendar.freeBusy",
  "calendar.findFirstFreeSlot",
  "calendar.onSaving",
  // Area 6, F5a: le riunioni registrate (meeting-notes).
  "mail.getMeetingSummary",
  "mail.tasksBornFrom",
  "mail.getMeetingByNote",
  "mail.tasksOfNote",
  "calendar.getMeetingPrep",
  // Area 7, F1: le Automations sul client vero (`data/backend/real/automationsLive.ts`).
  "automations.activate",
  "automations.approve",
  "automations.automationOrigin",
  "automations.cancelRun",
  "automations.checkDraft",
  "automations.chooseProject",
  "automations.createAutomation",
  "automations.deleteDraft",
  "automations.duplicateAutomation",
  "automations.endSimulation",
  "automations.confirmSimulationCost",
  "automations.getAutomation",
  "automations.getProjectAutomations",
  "automations.getRun",
  "automations.findRun",
  "automations.getSimulation",
  "automations.listAutomations",
  "automations.listMyApprovals",
  "automations.listMyRuns",
  "automations.listRuns",
  "automations.listSimulationExamples",
  "automations.onAutomationsSettled",
  "automations.pause",
  "automations.publish",
  "automations.reject",
  "automations.renameAutomation",
  "automations.reset",
  "automations.retryStep",
  "automations.saveDraft",
  "automations.searchAutomations",
  "automations.simulationStep",
  "automations.skipStep",
  "automations.startManual",
  "automations.startSimulation",
  "automations.whenAutomationsIdle",
  // Area 5: la ricerca nei Docs del progetto (`data/backend/real/docs.ts`), che la palette usa.
  "docs.searchDocs",
  // Area 8, F1 (`releases-prs`): le PR aperte, la coda e le loro scritture
  // (`data/backend/real/releasesLive.ts`).
  "releases.listOpenPrs",
  "releases.listReleaseQueue",
  "releases.mergePr",
  "releases.requestPrCorrection",
  "releases.setPrAnalysisOnly",
  "releases.setPrReleaseNotes",
  // Area 8, F1 (`releases`): i rilasci, «Fai sistemare a Claude», la Home «Rilasci».
  "releases.listReleases",
  "releases.getRelease",
  "releases.fixRelease",
  "releases.listMyReleases",
  // Area 8, F1 (`releases-repo-settings`): la sezione «Repositories» ridotta.
  "releases.getRepositorySettings",
  "releases.setRepoPrMode",
  // Area 8, F3: Support (letture e scritture sulle rotte di 72).
  "support.listSupportConversations",
  "support.getSupportConversation",
  "support.customerPreview",
  "support.replyToCollaborator",
  "support.openRequestFrom",
  "support.markNotConcluded",
  // I widget (support-widgets), sulle rotte di oggi.
  "support.listWidgets",
  "support.createWidget",
  "support.updateWidget",
  "support.deleteWidget",
  // API per i siti (S6).
  "support.regenerateIdentitySecret",
  // Area 8, F4a: i Server in sola lettura.
  "servers.listProjectServers",
  "servers.listAllServers",
  "servers.getServer",
  "servers.getServerMetrics",
  // Le scritture (`servers-write`); creare dentro un ambiente no.
  "servers.createServer",
  "servers.updateServer",
  "servers.setThresholds",
  "servers.deleteServer",
  "servers.regenerateAgentKey",
  "servers.createCheck",
  "servers.updateCheck",
  "servers.deleteCheck",
  // Gli ambienti (`environments`) e i server che si possono collegare.
  "releases.listEnvironments",
  "releases.createEnvironment",
  "releases.updateEnvironment",
  "releases.deleteEnvironment",
  "servers.listLinkableServers",
  // Area 8, F4b (R0-D): i container di un ambiente.
  "releases.setEnvironmentContainers",
  // Area 8, F4b: l'analisi a mano («Ask Claude to look into it»), col permesso del server.
  "servers.startServerAnalysis",
  // Area 8, F4b: l'accesso SSH di sola lettura, rigenerazione compresa.
  "servers.linkSshAccess",
  "servers.regenerateSshAccess",
  "servers.verifySshAccess",
  "servers.revokeSshAccess",
  "servers.getInstallCommand",
  "servers.getRemovalCommand",
  // R3: la chiave dei comandi, per il comando d'installazione con le operazioni.
  "servers.getCommandKey",
  // F4b: la sezione Server della task e la correzione.
  "servers.getServerTaskInfo",
  "servers.startServerFix",
  "servers.approveServerFix",
  "servers.rejectServerFix",
  "servers.stopServerFix",
  // Area 8, F2 (R6): le iscrizioni agli avvisi.
  "alerts.subscriptionRows",
  "alerts.setSubscription",
  "alerts.copySubscriptions",
  "alerts.muteProject",
  "alerts.muteFromNotification",
  "releases.setReleasePipeline",
  // Area 8, F1 (`releases-explain`): «Spiega» apre una conversazione col contesto del rilascio.
  "releases.explainRelease",
  // Area 7, F4 (accesa): sorgenti webhook, tabella cliente → progetto, tetto del
  // webhook (`data/backend/real/automationSources.ts`, `automations.ts`).
  "automations.listSources",
  "automations.listSourceEvents",
  "automations.createWebhookSource",
  "automations.renameSource",
  "automations.regenerateWebhookAddress",
  "automations.previewWebhookExample",
  "automations.setWebhookExample",
  "automations.updateWebhookField",
  "automations.listClientLinks",
  "automations.listClientSuggestions",
  "automations.setClientLink",
  "automations.removeClientLink",
  "automations.setWebhookLimits",
]);

const outside = () => [...new Set(calls)].filter((c) => !INTEGRATED_CALLS.has(c));

afterEach(() => {
  vi.unstubAllEnvs();
  resetApi();
});

const MORE = "More actions for AUD-9";
const DELETE = "Delete task\u2026";

/** Lascia partire le letture della shell. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("aree non integrate nella build app", () => {
  // Area 6, fetta 1: Posta e Calendario si leggono, ma solo con ciò che la build app ha
  // (niente bozze, scrittura, note di riunione). Una lettura di troppo è un buco del cancello.
  it("aprire la Posta legge solo ciò che è integrato", async () => {
    renderRoute("/mail");
    await waitFor(() => expect(calls).toContain("mail.listMailThreads"));
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 7, F1: le Automations sono accese (R8); l'elenco e il dettaglio
  // leggono dal server, senza «Coming soon».
  it("aprire le Automations legge solo ciò che è integrato", async () => {
    renderRoute("/automations");
    expect(await screen.findByRole("heading", { level: 1, name: "Automations" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("automations.listAutomations"));
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 7, F3 e F4 accese: il passo di Claude e «avvia un'altra» si scelgono.
  it("il costruttore offre il passo di Claude e «avvia un'altra»", async () => {
    signedInAs("p-laura");
    renderRoute("/automations/STW-A1/edit");
    const tree = await screen.findByRole("tree");
    const first = tree.querySelector<HTMLElement>("[data-step-path]")!;
    first.focus();
    await userEvent.keyboard("a");
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    expect(within(menu).getByRole("option", { name: /Claude reads and decides/ })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(
      within(menu).getByRole("option", { name: /Start another automation/ }),
    ).not.toHaveAttribute("aria-disabled");
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 7, F4: Sources e la tabella cliente → progetto leggono solo dal client vero.
  it("aprire Sources legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/automations/sources");
    await waitFor(() => expect(calls).toContain("automations.listSources"));
    await waitFor(() => expect(calls).toContain("automations.listClientLinks"));
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("aprire il Calendario legge solo ciò che è integrato", async () => {
    renderRoute("/calendar");
    await waitFor(() => expect(calls).toContain("calendar.listEvents"));
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 6, F4: la scrittura del Calendario è integrata (review F4): una nuova
  // riunione passa solo da funzioni integrate.
  it("scrivere nel Calendario (nuova riunione) chiama solo ciò che è integrato", async () => {
    renderRoute("/calendar?newMeeting=1&date=2026-10-23");
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText("Title"), "Kickoff");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContain("calendar.createEvent"));
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 6, F5a (Q-A = a, 46): l'invitato senza l'email di Gemini apre la
  // riunione per nota, e la conversazione non si legge MAI.
  it("la riunione per nota: si apre il pannello, la conversazione non si chiama mai", async () => {
    const { state } = await import("../data/store");
    const { EV_AUD_REVIEW_YESTERDAY, MAIL_CASES } = await import("../data/seed/mail");
    const m = state.mailMessages.find((x) => x.id === MAIL_CASES.transcript)!;
    m.to = m.to.filter((a) => a.personId !== "p-giulia");
    m.cc = (m.cc ?? []).filter((a) => a.personId !== "p-giulia");
    m.mailboxPersonIds = m.mailboxPersonIds.filter((id) => id !== "p-giulia");
    const e = state.calendarEvents.find((x) => x.id === EV_AUD_REVIEW_YESTERDAY)!;
    const shift = 90 * 86_400_000;
    e.startsAt = new Date(Date.parse(e.startsAt) - shift).toISOString();
    e.endsAt = new Date(Date.parse(e.endsAt) - shift).toISOString();
    // Nella build app chi guarda è la persona della sessione (Giulia).
    renderRoute("/home");
    const user = userEvent.setup();
    const decide = await screen.findByRole("region", { name: "Decide" });
    const item = await waitFor(() => {
      // Oltre le prime 5 voci, «Show N more» espande sul posto.
      const more = within(decide).queryByRole("button", { name: /^Show \d+ more$/ });
      if (more) fireEvent.click(more);
      const el = decide.querySelector<HTMLElement>('[data-mail-decision="mp-aud-weekly-review"]');
      if (!el) throw new Error("not yet");
      return el;
    });
    await user.click(within(item).getByRole("button", { name: "Open the meeting" }));
    await screen.findByRole("dialog", { name: m.subject });
    await waitFor(() => expect(calls).toContain("mail.getMeetingByNote"));
    await settle();
    expect(calls).not.toContain("mail.getMailThread");
    expect(outside()).toEqual([]);
  });

  // Dall'area 4 (fetta 1) la Chat è integrata: si legge, e solo con la fetta 1.
  it("aprire la Chat la legge, senza le funzioni delle fette dopo", async () => {
    renderRoute("/chat");
    await waitFor(() => expect(calls).toContain("chat.listChannels"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("aprire un progetto atterra sull'Overview", async () => {
    const router = renderRoute("/p/AUD");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/overview"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("le Tasks leggono solo ciò che è integrato", async () => {
    renderRoute("/p/AUD/tasks");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await settle();
    // Niente riga di Claude, niente blocchi dell'istanza.
    expect(outside()).toEqual([]);
  });

  it("il binario non legge i segnali delle aree future; la Chat sì, dalla fetta 1", async () => {
    renderRoute("/projects");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("una pagina di progetto non integrata mostra «Coming soon»", async () => {
    // Dall'area 8, F4a, ogni sezione di progetto è accesa: resta una voce delle impostazioni.
    renderRoute("/p/AUD/settings/plugins");
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  // Review area 8 F1, m5: le ricerche della palette delle aree non integrate non partono.
  it("cercare nella palette legge solo chiamate integrate (rilasci, Support, Servers spenti)", async () => {
    const user = userEvent.setup();
    renderRoute("/home");
    await screen.findByRole("region", { name: /^My tasks/ });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "AUD");
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(calls).not.toContain("releases.searchReleases");
    expect(calls).not.toContain("support.searchSupport");
    expect(calls).not.toContain("servers.searchServers");
    // Nemmeno la doc di prodotto (area 11, spenta) parte.
    expect(calls).not.toContain("productDocs.searchProductPages");
    expect(outside()).toEqual([]);
  });

  // Area 8, F1 (46): «Repositories» ridotta, senza «nuovo repository» né l'editor dell'area 9.
  it("aprire Repositories legge solo chiamate integrate, senza «Add repository»", async () => {
    // Laura vede il codice di AUD (`repos.view`): la sezione è sua.
    signedInAs("p-laura");
    renderRoute("/p/AUD/settings/repositories");
    await waitFor(() => expect(calls).toContain("releases.getRepositorySettings"));
    await settle();
    expect(screen.queryByRole("button", { name: /Add repository/ })).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 8, F1 (`releases-prs` e `releases`): PR, coda e rilasci dal server; ambienti «in arrivo».
  // Area 8, F2 (R6): Preferenze → Notifiche è accesa (`alerts`); legge le
  // iscrizioni dal server e nient'altro di non integrato.
  it("aprire Preferenze → Notifiche legge solo chiamate integrate", async () => {
    renderRoute("/preferences/notifications");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Notifications" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("alerts.subscriptionRows"));
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R4a: Preferenze → Account è accesa (`prefs-account`): profilo,
  // email e password dal server; le caselle Google stanno nel cassetto Google
  // (`prefs-mailboxes` spenta), e il riquadro «Prototype only» non c'è.
  it("aprire Preferenze → Account legge solo chiamate integrate, senza caselle né riquadro del prototipo", async () => {
    renderRoute("/preferences/account");
    expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("me.getMyProfile"));
    await settle();
    expect(calls).not.toContain("me.listMyMailboxes");
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R4b: Preferenze → Security è accesa (`prefs-security`).
  it("aprire Preferenze → Security legge solo chiamate integrate, senza riquadro del prototipo", async () => {
    renderRoute("/preferences/security");
    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("me.getMySecurity"));
    await settle();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("sul desktop le passkey sono del browser: la nota, niente «Add passkey» (area 9, R4b)", async () => {
    window.stubwise = { ...(window.stubwise ?? {}), api: { request: async () => ({}) } } as never;
    try {
      renderRoute("/preferences/security");
      expect(
        await screen.findByText(
          "Passkeys live in your browser: add or remove them from Stubwise in the browser.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add passkey" })).toBeNull();
    } finally {
      delete (window.stubwise as { api?: unknown } | undefined)?.api;
    }
  });

  // Area 9, F1, R7: People e Roles accese, sulle letture calcolate del server.
  it.each([
    ["/admin/people", "People"],
    ["/admin/people/p-marco", "Marco Bellini"],
    ["/admin/roles", "Roles"],
  ])("aprire %s legge solo chiamate integrate", async (path, title) => {
    signedInAs("p-roberta");
    renderRoute(path);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: AI → Providers acceso, sulle rotte dell'8c di 72; senza il
  // riquadro «Prototype only» (l'esito della prossima prova è del prototipo).
  it("aprire AI → Providers legge solo chiamate integrate, senza riquadro del prototipo", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/ai?tab=providers");
    await waitFor(() => expect(calls).toContain("instance.listProviders"));
    expect(await screen.findByRole("list", { name: "AI accounts" })).toBeInTheDocument();
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: Amministrazione → Storage, su `/api/settings/instance`; senza
  // la prova e l'interruttore degli allegati (il server non li ha).
  it("aprire Storage legge solo chiamate integrate, senza prova né interruttore degli allegati", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/storage");
    await waitFor(() => expect(calls).toContain("instance.getStorage"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Attachments" })).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: Amministrazione → Plugins, su `/api/plugins`.
  it.each([
    ["/admin/plugins", "instance.listPlugins"],
    ["/admin/plugins/plg-superpowers", "instance.getPlugin"],
  ])("aprire %s legge solo chiamate integrate, senza riquadro del prototipo", async (path, call) => {
    signedInAs("p-roberta");
    renderRoute(path);
    await waitFor(() => expect(calls).toContain(call));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: Amministrazione → Git accounts, su `/api/git-accounts`.
  it("aprire Git accounts legge solo chiamate integrate, senza riquadro del prototipo", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/git-accounts");
    await waitFor(() => expect(calls).toContain("instance.listGitAccounts"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: Amministrazione → Google Workspace, su `/api/settings/google-workspaces`.
  it("aprire Google Workspace e il suo dialogo legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/google");
    await waitFor(() => expect(calls).toContain("instance.listGoogleApps"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add an app" }));
    await user.click(await screen.findByRole("button", { name: "How to set it up in Google Cloud" }));
    await waitFor(() => expect(calls).toContain("instance.getGoogleRedirectUri"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F4: AI → Budget & language, su `/api/settings/instance`; senza
  // la simulazione del budget raggiunto (solo prototipo).
  it("aprire AI → Budget legge solo chiamate integrate, senza riquadro del prototipo", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/ai?tab=budget");
    await waitFor(() => expect(calls).toContain("instance.getBudget"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: AI → Models acceso, su `/api/settings/models`.
  it("aprire AI → Models legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/ai?tab=models");
    await waitFor(() => expect(calls).toContain("instance.listModels"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: AI → Automation accesa, su `/api/settings/automation`.
  it("aprire AI → Automation legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/ai?tab=automation");
    await waitFor(() => expect(calls).toContain("instance.getAutomation"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F4 (72, 5713037b2): la pausa della coda nella colonna del
  // progetto, dalla vista del progetto (`queuePause`).
  it("la colonna di un progetto in pausa lo dice, con chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/p/STW/overview");
    await waitFor(() => expect(calls).toContain("instance.getQueuePause"));
    await waitFor(() => expect(document.querySelector("[data-queue-paused]")).not.toBeNull());
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 9, F4: Amministrazione → Instance status, su `GET /api/instance/status`,
  // con pausa, ripresa e rilancio di 72.
  it("aprire Instance status legge solo chiamate integrate, senza riquadro del prototipo", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/status");
    await waitFor(() => expect(calls).toContain("instance.getInstanceStatus"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F4: AI → Usage, su `GET /api/ai-usage/summary`.
  it("aprire AI → Usage legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/ai?tab=usage");
    await waitFor(() => expect(calls).toContain("instance.getUsage"));
    await settle();
    expect(document.querySelector("[data-coming-soon]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F3: Outgoing webhooks accesi, sulle rotte del server; senza il
  // riquadro «Prototype only» (l'esito della prossima prova è del prototipo).
  it.each([
    ["/admin/webhooks", "Outgoing webhooks"],
    ["/admin/webhooks/wh-seed", "Webhook"],
  ])("aprire %s legge solo chiamate integrate, senza riquadro del prototipo", async (path, title) => {
    signedInAs("p-roberta");
    renderRoute(path);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F2: il registro delle modifiche, in Amministrazione e nel progetto.
  it("aprire Amministrazione → Change log legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/changelog");
    await waitFor(() => expect(calls).toContain("changelog.listChangesPage"));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("aprire Change log di un progetto legge solo chiamate integrate", async () => {
    signedInAs("p-laura");
    renderRoute("/p/ACQ/settings/changelog");
    await waitFor(() => expect(calls).toContain("changelog.listProjectChangesPage"));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F5: Progetto → Settings → Integration accesa.
  it("aprire Integration di un progetto legge solo chiamate integrate", async () => {
    signedInAs("p-laura");
    renderRoute("/p/ACQ/settings/integration");
    await waitFor(() => expect(calls).toContain("projectSettings.getIntegration"));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R8: Progetto → Settings → Members accesa.
  it("aprire Members di un progetto legge solo chiamate integrate", async () => {
    signedInAs("p-laura");
    renderRoute("/p/ACQ/settings/members");
    await waitFor(() => expect(calls).toContain("admin.listProjectMembers"));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R9: Amministrazione → Who can? accesa, sulle rotte del server.
  it("aprire «Who can?» legge solo chiamate integrate", async () => {
    signedInAs("p-roberta");
    renderRoute("/admin/who-can?action=approvePlan&project=ACQ");
    await waitFor(() => expect(calls).toContain("access.whoCan"));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R5: le pagine d'ingresso della web «app» (reset e primo avvio),
  // senza i riquadri del prototipo.
  it("il link di reset nella web «app» legge solo chiamate integrate", async () => {
    renderRoute("/reset-password/made-up-token");
    await waitFor(() => expect(calls).toContain("auth.getResetLink"));
    await settle();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("l'invito nella web «app» legge solo chiamate integrate", async () => {
    renderRoute("/register/made-up-token");
    await waitFor(() => expect(calls).toContain("auth.getInvite"));
    await settle();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("il primo avvio nella web «app»: il modulo, senza «Reset to empty instance»", async () => {
    // L'istanza senza nessuno: una preparazione del test, non una chiamata della pagina.
    await fakeAuth.resetToEmptyInstance();
    calls.length = 0;
    renderRoute("/setup");
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    await settle();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 9, F1, R4c e R4d: Tokens, Claude Code e Language & theme accese.
  it.each([
    ["/preferences/tokens", "Tokens", "me.listTokens"],
    ["/preferences/claude-code", "Claude Code", null],
    ["/preferences/look", "Language & theme", null],
  ])("aprire %s legge solo chiamate integrate", async (path, title, read) => {
    renderRoute(path);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    if (read) await waitFor(() => expect(calls).toContain(read));
    await settle();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 8, F3: Support acceso (letture e scritture) e i widget; la Home e la
  // ricerca hanno le loro funzioni, spente. Bozza di Claude, email e «Segui» non ci sono più.
  it("aprire Support legge solo chiamate integrate, senza bozza di Claude, email né «Segui»", async () => {
    const user = userEvent.setup();
    signedInAs("p-matteo");
    renderRoute("/p/ACQ/support/ACQ-S2");
    const detail = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>('[data-support-detail="ACQ-S2"]');
        if (!el) throw new Error("no detail");
        return el;
      },
      { timeout: 3000 },
    );
    await waitFor(() => expect(calls).toContain("support.getSupportConversation"));
    await waitFor(() => expect(calls).toContain("support.listSupportConversations"));
    // Al cliente del widget il team non scrive (area 8, F3): nessuna casella, né «Ask Claude».
    await within(detail).findByRole("region", { name: "Request" });
    expect(within(detail).queryByRole("form", { name: /^Reply to / })).toBeNull();
    expect(within(detail).queryByRole("button", { name: /^Ask Claude/ })).toBeNull();
    // «Write to them by email» non c'è più (area 8, F3, decisione del maintainer).
    expect(within(detail).queryByRole("button", { name: "Write to them by email" })).toBeNull();
    // «Segui» nemmeno.
    expect(within(detail).queryByRole("button", { name: /^Follow/ })).toBeNull();
    // Nessuna simulazione del prototipo nel menu.
    await user.click(within(detail).getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /^Simulate/ })).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("la risposta al collaboratore del canale mcp (area 8, F3): la casella c'è e scrive con una chiamata integrata", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    signedInAs("p-matteo");
    renderRoute("/p/ACQ/support/ACQ-S4");
    const form = await screen.findByRole("form", { name: /^Reply to / }, { timeout: 3000 });
    await user.type(within(form).getByRole("textbox", { name: "Message" }), "On it.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await act(() => vi.advanceTimersByTimeAsync(REPLY_UNDO_MS + 100));
    await waitFor(() => expect(calls).toContain("support.replyToCollaborator"));
    vi.useRealTimers();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("i widget di Support (area 8, F3, support-widgets): elenco e pannello sulle chiamate integrate, coi siti ammessi", async () => {
    signedInAs("p-matteo");
    renderRoute("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" }, { timeout: 3000 });
    await waitFor(() => expect(calls).toContain("support.listWidgets"));
    // I siti ammessi (`origins` del server): il campo c'è anche nella build app.
    expect(within(panel).getByLabelText(/^Sites/)).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  // Area 8, F4a: i Server in sola lettura (elenco, dettaglio, metriche, episodi).
  // Scritture, SSH, analisi e simulazioni restano fuori dalla build app (I1).
  it("i Server del progetto: l'elenco e «New server» dentro un ambiente (decisione c), solo chiamate integrate", async () => {
    // Roberta ha `monitor.manage` ed `environments.manage`.
    signedInAs("p-roberta");
    renderRoute("/p/ACQ/servers");
    expect(await screen.findByRole("heading", { level: 1, name: "Servers" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("servers.listProjectServers"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(await screen.findByRole("button", { name: "New server" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("il dettaglio di un Server: metriche, episodi, scritture e l'accesso SSH; niente progetto principale né simulazioni", async () => {
    // Roberta ha `monitor.manage`: le scritture ci sono, la F4b no.
    signedInAs("p-roberta");
    renderRoute("/p/ACQ/servers/SRV-1");
    const index = await screen.findByRole("navigation", { name: "Parts of SRV-1" }, { timeout: 3000 });
    await waitFor(() => expect(calls).toContain("servers.getServer"));
    await waitFor(() => expect(calls).toContain("servers.getServerMetrics"));
    // F4b: l'accesso SSH di sola lettura c'è.
    expect(within(index).getByRole("button", { name: "SSH access" })).toBeInTheDocument();
    expect(within(index).getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add check" })).toBeInTheDocument();
    // Il progetto principale (dell'analisi, F4b) non si offre.
    expect(screen.queryByText("Primary project")).toBeNull();
    expect(screen.queryByRole("region", { name: "Prototype only: server signals" })).toBeNull();
    // F4b: l'analisi è accesa (letta sugli episodi); senza l'SSH integrato non si
    // dice che manca l'accesso, e il bottone dell'analisi a mano segue il server.
    expect(screen.queryByText(/won't include SSH reads/)).toBeNull();
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("F4b: la sezione Server di una task e la scheda del piano, solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-roberta");
    renderRoute("/p/ACQ/tasks?task=ACQ-6");
    const panel = await screen.findByRole("dialog", { name: "Task ACQ-6" }, { timeout: 3000 });
    const section = () => within(panel).getByRole("region", { name: "Server" });
    await waitFor(() => expect(calls).toContain("servers.getServerTaskInfo"));
    await waitFor(() => expect(section()).toHaveTextContent("SRV-1"), { timeout: 5000 });
    await user.click(await within(section()).findByRole("button", { name: /^Start fix/ }));
    const dialog = await screen.findByRole("dialog", { name: "Start a fix on SRV-1?" });
    // Le note per Claude il server non le prende: nell'app il campo non c'è.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Start fix" }));
    await waitFor(() => expect(calls).toContain("servers.startServerFix"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("F4b: l'analisi a mano dal dettaglio del server, solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-marco");
    renderRoute("/p/ACQ/servers/SRV-1");
    await user.click(
      await screen.findByRole("button", { name: "Ask Claude to look into it" }, { timeout: 3000 }),
    );
    await waitFor(() => expect(calls).toContain("servers.startServerAnalysis"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("F4b: l'accesso SSH: «Now» dice che mancano le letture SSH, e si collega dalla parte; solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-roberta");
    renderRoute("/p/STW/servers/SRV-2");
    const now = await screen.findByRole("region", { name: "Now" }, { timeout: 3000 });
    expect(now).toHaveTextContent("In trouble since");
    expect(
      within(now).getByText("Claude's diagnosis won't include SSH reads: no SSH access."),
    ).toBeInTheDocument();
    const part = screen.getByRole("region", { name: "SSH access" });
    await user.click(within(part).getByRole("button", { name: "Link SSH access" }));
    await waitFor(() => expect(calls).toContain("servers.linkSshAccess"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("l'Amministrazione dei Server: tutti i server e «New server» (nasce orfano), la chiave una volta; solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-roberta");
    renderRoute("/admin/servers");
    await waitFor(() => expect(calls).toContain("servers.listAllServers"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "edge-01");
    await user.click(within(dialog).getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(calls).toContain("servers.createServer"));
    expect(await screen.findByText(/STUBWISE_SERVER_KEY=sk_/)).toBeInTheDocument();
    // R3: le operazioni dell'agente accese mettono nel comando la chiave dei comandi.
    await user.click(screen.getByRole("checkbox", { name: "Let the agent run fix actions" }));
    await waitFor(() => expect(calls).toContain("servers.getCommandKey"));
    // La chiave è vera: niente nota del prototipo (review F4a, I4).
    expect(screen.queryByText(/Prototype: this key is made up/)).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("gli ambienti (area 8, F4a): il server fra quelli visibili, il tipo fermo in modifica, solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-laura");
    renderRoute("/p/AUD/releases");
    const part = await screen.findByRole("region", { name: /^Environments/ }, { timeout: 3000 });
    await user.click(await within(part).findByRole("button", { name: "Add environment" }));
    const add = await screen.findByRole("dialog", { name: "Add environment" });
    await waitFor(() => expect(calls).toContain("servers.listLinkableServers"));
    const list = document.getElementById(
      within(add).getByRole("combobox", { name: "Server" }).getAttribute("list")!,
    )!;
    await waitFor(() => expect(list.querySelectorAll("option").length).toBeGreaterThan(0));
    // Nell'aggiungere il tipo si sceglie.
    expect(within(add).getByRole("radio", { name: "Test" })).toBeEnabled();
    await user.click(within(add).getByRole("button", { name: "Cancel" }));
    await user.click(within(part).getByRole("button", { name: "More for Production" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit environment" });
    expect(within(edit).getByRole("radio", { name: "Test" })).toBeDisabled();
    expect(within(edit).getByRole("radio", { name: "Production" })).toBeChecked();
    expect(
      within(edit).getByText("The type can't change: for another type, add a new environment."),
    ).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("i container di un ambiente (area 8, F4b, R0-D): si leggono e si scelgono dal catalogo del server, solo chiamate integrate", async () => {
    const user = userEvent.setup();
    signedInAs("p-roberta");
    renderRoute("/p/ACQ/releases");
    const part = await screen.findByRole("region", { name: /^Environments/ }, { timeout: 3000 });
    expect(await within(part).findByText(/^Containers on SRV-1: /)).toBeInTheDocument();
    await user.click(within(part).getByRole("button", { name: "More for Production" }));
    await user.click(await screen.findByRole("menuitem", { name: "Containers on SRV-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Containers of Production on SRV-1" });
    await waitFor(() => expect(calls).toContain("servers.getServer"));
    await user.click(await within(dialog).findByRole("checkbox", { name: "caddy" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContain("releases.setEnvironmentContainers"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("aprire Releases legge solo chiamate integrate", async () => {
    renderRoute("/p/AUD/releases");
    expect(await screen.findByRole("region", { name: "Pull requests" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("releases.listOpenPrs"));
    await waitFor(() => expect(calls).toContain("releases.listReleaseQueue"));
    await settle();
    await waitFor(() => expect(calls).toContain("releases.listReleases"));
    // Area 8, F4a: gli ambienti accesi, coi server che chi scrive vede.
    await waitFor(() => expect(calls).toContain("releases.listEnvironments"));
    expect(
      within(screen.getByRole("region", { name: /^Environments/ })).queryByText("Coming soon"),
    ).toBeNull();
    expect(outside()).toEqual([]);
  });

  // Area 6, F5b: Google Drive nel Drive dei progetti è integrato.
  it("il Drive del progetto (area 5 e area 6, F5b): i caricati e Google", async () => {
    renderRoute("/p/AUD/drive");
    expect(await screen.findByRole("heading", { level: 1, name: /Drive/ })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("drive.listDriveFiles"));
    await waitFor(() => expect(calls).toContain("drive.listFolderLinks"));
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(screen.getByRole("button", { name: "Add from Google Drive" })).toBeInTheDocument();
    expect(outside()).toEqual([]);
  });

  it("F5b: «Add from Google Drive» legge il mio Drive, e solo da funzioni integrate", async () => {
    renderRoute("/p/AUD/drive");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add from Google Drive" }));
    await screen.findByRole("dialog", { name: /Google Drive/ });
    await waitFor(() => expect(calls).toContain("drive.listGoogleFiles"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("il cassetto Google (area 6): dal menu del profilo", async () => {
    renderRoute("/projects");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("button", { name: "Google account" }));
    const dialog = await screen.findByRole("dialog", { name: "Google account" });
    await waitFor(() => expect(calls).toContain("drive.getGoogleAccount"));
    await settle();
    // Le cartelle che ho collegato si leggono solo scollegando (review F5b, 9).
    expect(calls).not.toContain("drive.listMyFolderLinks");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls).toContain("drive.listMyFolderLinks"));
    expect(await within(dialog).findByText(/folder you linked will stop updating/)).toBeInTheDocument();
    expect(outside()).toEqual([]);
    act(() => closeGoogleAccount());
  });

  it("la destinazione Drive: tutti i progetti, coi riferimenti Google (F5b)", async () => {
    renderRoute("/drive");
    await waitFor(() => expect(calls).toContain("drive.listDriveFiles"));
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    // Le righe dei riferimenti Google ci sono, col loro segno (review F5b, 9).
    expect((await screen.findAllByTitle("Google file, opens in Google Drive")).length).toBeGreaterThan(0);
    expect(outside()).toEqual([]);
  });

  // Dal Task 17 la sezione Claude dice lo stato vero (e «Open in web» nel web vecchio).
  // Da F3.0 della chat «Delete task…» c'è nel menu «⋯» (Marco può eliminare).
  it("nel dettaglio della task la sezione Claude c'è intera; a lavoro finito nessuna azione, e «Delete» nel menu", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-9");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-9" });
    const claudeRegion = () => within(panel).getByRole("region", { name: "Claude" });
    // Dalla 3a la sezione legge il lavoro intero (`getTaskWork`), non più il riassunto della fetta 1.
    await waitFor(() => expect(claudeRegion()).toHaveTextContent("Claude finished its work."));
    expect(within(claudeRegion()).queryByText("Coming soon")).toBeNull();
    expect(within(claudeRegion()).queryByText("Open in web")).toBeNull();
    expect(
      within(claudeRegion()).queryByRole("button", {
        name: /Assign to Claude|^Start|Relaunch|Resume the correction|Request changes/,
      }),
    ).toBeNull();
    await user.click(within(panel).getByRole("button", { name: MORE }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByText(DELETE)).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("getTaskWork");
  });

  it("nel prototipo la Chat resta la Chat", async () => {
    vi.unstubAllEnvs();
    renderRoute("/chat");
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });
});

describe("le superfici della fetta 2 nella build app", () => {
  it("/planning senza planning.others torna alla Home", async () => {
    signedInAs("p-marco");
    const router = renderRoute("/planning");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
  });

  // Area 3, fetta 3e: Claude è assegnabile (`claude-assign`). Nel finto lo è
  // dove è membro (sul server dove lo dice `claudeAssignableProjectIds`); la
  // sua riga c'è sempre, in sola lettura dove chi guarda non può assegnarlo.
  it("il Planning trasversale c'è per chi ha planning.others, con la riga di Claude", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(await screen.findByRole("rowheader", { name: /Claude/ })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("in un progetto dove Claude non si assegna, la sua riga c'è in sola lettura col motivo", async () => {
    signedInAs("p-laura");
    // Qui Claude non è membro di AUD: non si assegna (nel finto l'assegnabilità è l'appartenenza).
    const { state } = await import("../data/store");
    const aud = state.projectsById.get("prj-aud")!;
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-claude");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    const head = await screen.findByRole("rowheader", { name: /Claude/ });
    expect(head).toHaveAttribute("data-readonly", "true");
    expect(head).toHaveAttribute("title", "Only someone who can start Claude's work plans for Claude");
  });

  it("il menu «Plan» propone Claude dove si assegna", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-pool] [data-chip]")).not.toBeNull());
    const chip = document.querySelector<HTMLElement>("[data-pool] [data-chip]")!;
    chip.focus();
    await userEvent.keyboard("p");
    const menu = await screen.findByRole("menu", { name: /^Plan / });
    const names = within(menu).getAllByRole("menuitemradio").map((i) => i.textContent ?? "");
    expect(names.length).toBeGreaterThan(0);
    // AUD (software): Claude ne è membro, quindi si assegna, ed è l'ultima voce.
    expect(names.at(-1)).toMatch(/Claude/);
  });

  it("il Planning di progetto è disponibile", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("troncato: l'avviso compare nel Planning e in La mia settimana", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.queryByText("Some tasks are missing from the load.")).toBeNull();
    cleanup();
    truncated.value = true;
    renderRoute("/planning");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
    cleanup();
    renderRoute("/home?view=week");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
  });

  it("troncato: l'avviso compare anche quando è troncata solo la vasca del Planning", async () => {
    signedInAs("p-laura");
    truncated.onlyFiltered = true;
    renderRoute("/p/AUD/planning");
    // Una frase sua: il carico è intero, mancano task da «To plan».
    expect(await screen.findByText("Some tasks are missing from To plan.")).toBeInTheDocument();
    expect(screen.queryByText("Some tasks are missing from the load.")).toBeNull();
  });

  it("la Timeline è disponibile", async () => {
    renderRoute("/p/AUD/tasks?view=timeline");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });
});

/** I blocchi delle aree non integrate (rilasci, assistenza). */
// «Upcoming» (gli appuntamenti) è acceso dall'area 6, fetta 1; «Important email» dalla fetta 2;
// «Automations» dall'area 7, fetta 1.
// Dall'area 8 (fetta 1) «Releases» è integrato: resta futuro «Customers waiting».
/**
 * «Clienti in attesa»: spento nella build app (area 8, F3, decisione del
 * maintainer): la sua fonte non è il widget ma posta e automazioni, da definire.
 * Resta nel catalogo: salvato in una Home non si mostra e non legge nulla.
 */
const WAITING_BLOCK = /^Customers waiting/;

describe("le superfici della fetta 3 nella build app", () => {
  it("dopo il login si atterra sulla Home a blocchi", async () => {
    const router = renderRoute("/login");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /^Decide/ })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("l'indirizzo vuoto atterra sulla Home", async () => {
    const router = renderRoute("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).not.toHaveProperty("view");
  });

  it("i blocchi delle aree non integrate non si mostrano e non leggono nulla («Releases» sì, dall'area 8)", async () => {
    // Laura può rilasciare e non ha personalizzato la Home: vede «Releases» (integrato), legge solo chiamate integrate.
    signedInAs("p-laura");
    renderRoute("/home");
    expect(await screen.findByRole("region", { name: /^My week/ })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /^My tasks/ })).toBeInTheDocument();
    // «Clienti in attesa» non è nelle Home di default [A 17].
    expect(screen.queryByRole("region", { name: WAITING_BLOCK })).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("«Clienti in attesa» nella Home personale legge la posta (area 8): solo chiamate integrate", async () => {
    signedInAs("p-marco");
    const { setPersonalHome } = await import("../data/api");
    await setPersonalHome([{ kind: "waitingCustomers" }, { kind: "myTasks" }]);
    calls.length = 0;
    renderRoute("/home");
    expect(await screen.findByRole("region", { name: WAITING_BLOCK })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("mail.listWaitingCustomers"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("il catalogo dei blocchi propone «Clienti in attesa» nella build app (area 8, dalla posta)", async () => {
    signedInAs("p-marco");
    renderRoute("/home");
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    const names = within(menu)
      .queryAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
    expect(names.some((n) => WAITING_BLOCK.test(n))).toBe(true);
    await settle();
    expect(outside()).toEqual([]);
  });

  it("«Da decidere» legge Claude (dalla 3b), le domande della Chat (area 4, fetta 2) le proposte della Posta (area 6, fetta 1) e le approvazioni delle automazioni (area 7, F1), e non resta in caricamento", async () => {
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    await waitFor(() => expect(decide.querySelector("[data-skeleton], [aria-busy='true']")).toBeNull());
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("listClaudeDecisions");
    expect(calls).toContain("mail.listMailDecisions");
    expect(calls).toContain("automations.listMyApprovals");
  });

  it("i filtri salvati: tutti i filtri e la pagina di un filtro", async () => {
    renderRoute("/filters");
    expect(await screen.findByRole("heading", { level: 1, name: "All filters" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    cleanup();
    renderRoute("/filters/flt-unassigned");
    expect(await screen.findByRole("heading", { level: 1, name: /Unassigned/ })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("La mia settimana resta raggiungibile da /home?view=week", async () => {
    renderRoute("/home?view=week");
    expect(await screen.findByRole("heading", { level: 1, name: "My week" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });
});

describe("le superfici della fetta 4 nella build app", () => {
  it("l'Overview è disponibile e legge solo ciò che è integrato", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("Requests: l'elenco e il dettaglio, senza letture di aree non integrate", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/requests");
    expect(await screen.findByRole("heading", { level: 1, name: "Requests" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    cleanup();
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    // Dalla fetta 3c (area 3) il refine con Claude è acceso.
    expect(await within(panel).findByRole("button", { name: "Refine with Claude" })).toBeEnabled();
    cleanup();
    // `?refine=1` apre la vista del refinement (fetta 3c), che legge la sessione della richiesta.
    renderRoute("/p/STW/requests?request=req-stw-1&refine=1");
    await waitFor(() => expect(calls).toContain("getRefineOf"));
    await settle();
    expect(outside()).toEqual([]);
  });

  it("Tutti i progetti è disponibile", async () => {
    signedInAs("p-laura");
    renderRoute("/projects");
    expect(await screen.findByRole("heading", { level: 1, name: "All projects" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("una richiesta fusa dall'intake: «Unita a R4», e si apre quella", async () => {
    signedInAs("p-laura");
    intake.mergeInto = "STW-R4";
    const router = renderRoute("/p/STW/requests?newRequest=STW");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    await userEvent.type(within(dialog).getByLabelText("What do you need?"), "Mute notifications at night");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      await screen.findByText("Merged into STW-R4: someone had already asked for this, and now you follow it."),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ request: "req-stw-4" }));
  });

  it("una richiesta accodata senza esito: «la stiamo registrando», il dialogo si chiude e niente «Riprova»", async () => {
    signedInAs("p-laura");
    intake.pending = true;
    renderRoute("/p/STW/requests?newRequest=STW");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    await userEvent.type(within(dialog).getByLabelText("What do you need?"), "Mute notifications at night");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      await screen.findByText("Received: we're still registering it. You'll find it in Requests."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New request" })).not.toBeInTheDocument());
    expect(screen.queryByText("Couldn't send the request. Nothing was sent; try again.")).not.toBeInTheDocument();
    expect(calls.filter((c) => c === "createRequest")).toHaveLength(1);
  });

  it("«Fondi in…»: l'attesa della riscrittura, e un errore con «Try again» che non ha cambiato nulla", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Merge into…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge into another request" });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /Quiet hours for notifications/ }));
    failNext("mergeRequest");
    setLatency(300);
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect(
      await within(dialog).findByText("Merging into STW-R4: Claude is rewriting it. This can take a moment."),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText("Couldn't merge the requests. Nothing changed.", {}, { timeout: 2000 })).toBeInTheDocument();
    setLatency(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Merge into another request" })).toBeNull());
  });

  it("oltre i 200 filtri il salvataggio lo dice con la sua frase", async () => {
    renderRoute("/p/AUD/tasks");
    await userEvent.click(await screen.findByRole("button", { name: "Save as filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as filter" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "One more");
    refusal.fn = "saveFilter";
    refusal.code = "too_many_filters";
    await userEvent.click(within(dialog).getByRole("button", { name: "Save filter" }));
    expect(
      await within(dialog).findByText("You already have 200 saved filters. Delete one to save another."),
    ).toBeInTheDocument();
  });

  it("modifiche salvate ma suggerimenti non chiusi: il messaggio dice cosa è stato salvato", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    const box = await within(panel).findByRole("region", { name: "Suggested by the intake" });
    refusal.fn = "updateRequest";
    refusal.code = "suggestions_kept";
    await userEvent.click(within(box).getByRole("button", { name: "Dismiss" }));
    expect(
      await screen.findByText("Your changes were saved, but the suggestions are still open. Dismiss them again."),
    ).toBeInTheDocument();
  });

  it("trasformare una richiesta già trasformata o archiviata lo dice con la sua frase", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "Turn into task" }));
    const dialog = await screen.findByRole("dialog", { name: /New task/ });
    refusal.fn = "convertRequest";
    refusal.code = "request_not_convertible";
    await userEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(
      await within(dialog).findByText("This request has already been converted or archived."),
    ).toBeInTheDocument();
  });

  it("trasformare una richiesta che non vedi più lo dice con la sua frase", async () => {
    signedInAs("p-laura");
    renderRoute("/p/STW/requests?request=req-stw-1");
    const panel = await screen.findByRole("dialog");
    await userEvent.click(await within(panel).findByRole("button", { name: "Turn into task" }));
    const dialog = await screen.findByRole("dialog", { name: /New task/ });
    refusal.fn = "convertRequest";
    refusal.code = "request_not_found";
    await userEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(
      await within(dialog).findByText("This request is no longer available: it may have been converted, archived or hidden."),
    ).toBeInTheDocument();
  });
});

describe("le superfici della fetta 3a nella build app (area 3)", () => {
  // Dalle fette 1–2 della chat la chat libera è integrata: /claude atterra su
  // «New conversation», con «Mine» nella colonna; le pubbliche restano «in arrivo».
  it("/claude atterra su «New conversation», con «Mine» e le sessioni dal vivo nella colonna", async () => {
    signedInAs("p-laura");
    renderRoute("/claude");
    expect(await screen.findByRole("heading", { level: 1, name: "New conversation" })).toBeInTheDocument();
    const column = screen.getByRole("navigation", { name: "Claude views" });
    expect(within(column).getByText("New conversation")).toBeInTheDocument();
    expect(within(column).getByText("Mine")).toBeInTheDocument();
    expect(within(column).getByText("Finished")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).not.toContain("getClaudeSuggestion");
  });

  // Dalla fetta 5 anche le pubbliche sono integrate: «Public» si legge.
  it("le pubbliche e le proprie si leggono, nessuna è «in arrivo»", async () => {
    signedInAs("p-laura");
    renderRoute("/claude?scope=public");
    await waitFor(() => expect(calls).toContain("listConversations"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
    cleanup();
    renderRoute("/claude?scope=mine");
    await waitFor(() => expect(calls).toContain("listConversations"));
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });

  it("una sessione di lavoro si apre e si legge dal vivo", async () => {
    signedInAs("p-marco");
    renderRoute("/claude/cv-run-aud-3");
    expect(await screen.findByText(/Task run/)).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
    expect(calls).toContain("getConversation");
    expect(calls).toContain("subscribe");
  });
});

