import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleIdOf } from "../access/index";
import { admin, alerts, instance, projectSettings, resetApi, setLatency } from "../api";
import {
  addComment,
  archiveRequest,
  createRequest,
  deleteComment,
  deleteCommentAs,
  deleteMilestone,
  deleteMilestoneAs,
  reopenRequest,
  reopenRequestAs,
} from "../api-mutations";
import { addMemberAs, removeMemberAs, setMemberRoleAs } from "../admin/members";
import { setSubscriptionAs } from "../alerts/writes";
import { markReauthenticated } from "../auth/reauth";
import { saveAutomationAs } from "../instance/automation";
import { saveBudgetAs } from "../instance/budget";
import { setDefaultReviewerAs, updateGitAccountAs } from "../instance/git";
import { updateGoogleAppAs } from "../instance/google";
import { setModelAs } from "../instance/models";
import {
  registerPluginAs,
  removePluginAs,
  rerunSmokeAs,
  updatePluginRefAs,
} from "../instance/plugins";
import { moveProviderAs, setProviderEnabledAs } from "../instance/providers";
import { pauseQueueAs, resumeQueueAs } from "../instance/queue";
import { retryJobAs } from "../instance/retry";
import { saveStorageAs, setAttachmentsAs } from "../instance/storage";
import { saveWebhookAs } from "../instance/webhook";
import { setProjectAiAs } from "../projectSettings/ai";
import { archiveProjectAs, reopenProjectAs } from "../projectSettings/archive";
import { saveProjectAutomationsAs } from "../projectSettings/automations";
import { updateProjectGeneralAs } from "../projectSettings/general";
import { settingsOf } from "../projectSettings/reads";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { whenIdle } from "../stream";

// Le forme sincrone delle scritture del catalogo di Claude (area 10a, Task
// 1). Ogni `…As` è la pubblica senza il cancello: stesso esito sullo stesso
// stato, stessa voce del registro, stesso stato dopo. E nessuna attesa: il
// risultato non è una `Promise` (ruling del controller (pre-flight), P15),
// perché `applyActions` le chiama dentro un gruppo che non aspetta niente.
//
// Ogni caso gira due volte, ciascuna su uno stato appena ripristinato: una
// con la pubblica, una con la `…As`. Persone del seme: Roberta (full
// admin), Laura (Project Lead in ACQ), Sara (Contributor in ACQ), Giulia
// (Project Lead in RNC, l'archiviato), Marco (membro senza permessi
// d'istanza).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ACQ = "prj-acq";
const RNC = "prj-rnc";
const STW = "prj-stw";
const AUD = "prj-aud";
const BITBUCKET = "git-bitbucket-audin";

const as = (personId: string) => setSessionPersonId(personId);

/**
 * Lo stato intero, leggibile: le Map e i Set come elenchi. Senza i campioni
 * del monitoraggio dei server (oltre 20 MB, nessuna di queste scritture li
 * tocca): con loro ogni caso costerebbe mezzo secondo.
 */
const SKIPPED = new Set(["serverMetrics", "serverCheckSamples"]);
function digest(): string {
  return JSON.stringify(state, function (this: unknown, key, value: unknown) {
    if (this === state && SKIPPED.has(key)) return undefined;
    if (value instanceof Map) return [...value.entries()];
    if (value instanceof Set) return [...value];
    return value;
  });
}

/** Ciò che una scrittura ha fatto: il risultato (o l'errore), le voci nuove del registro, lo stato dopo. */
interface Effect {
  outcome: { value: unknown } | { error: string };
  entries: unknown[];
  state: string;
}

async function effectOf(call: () => Promise<unknown>): Promise<Effect> {
  const from = state.changelog.length;
  let outcome: Effect["outcome"];
  try {
    outcome = { value: await call() };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  return { outcome, entries: state.changelog.slice(from), state: digest() };
}

/** Come `effectOf`, ma la chiamata deve rispondere senza attese. */
function syncEffectOf(call: () => unknown): Effect {
  const from = state.changelog.length;
  let outcome: Effect["outcome"];
  try {
    outcome = { value: call() };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  // Fuori dal `try`: un'attesa è un fallimento del test, non un esito della scrittura.
  if ("value" in outcome) expect(outcome.value instanceof Promise).toBe(false);
  return { outcome, entries: state.changelog.slice(from), state: digest() };
}

/** L'esito in una parola: `ok`, il codice d'errore della risposta, o il messaggio lanciato. */
function verdict(outcome: Effect["outcome"]): string {
  if ("error" in outcome) return outcome.error.replace(/:.*$/, "");
  const v = outcome.value as { ok?: boolean; error?: string } | undefined;
  if (v && typeof v === "object" && "ok" in v) return v.ok ? "ok" : v.error!;
  return "ok";
}

type Ctx = Record<string, string>;

interface Case {
  name: string;
  who: string;
  /** Prepara lo stato (prima del cancello), e dà gli id che servono alla chiamata. */
  prep?: () => Promise<Ctx | void>;
  reauth?: boolean;
  pub: (ctx: Ctx) => Promise<unknown>;
  sync: (me: string, ctx: Ctx) => unknown;
  /** L'esito atteso, perché il confronto copra davvero riuscita e rifiuti. */
  expected: string;
}

async function fresh(c: Case): Promise<Ctx> {
  resetApi();
  setLatency(0);
  as(c.who);
  const ctx = (await c.prep?.()) ?? {};
  as(c.who);
  if (c.reauth) markReauthenticated(c.who);
  return ctx;
}

const automationsInput = (days: number) => {
  const s = settingsOf(state.projectsById.get(ACQ)!);
  return {
    switches: { ...s.switches },
    pulseEveryDays: days,
    correctionCap: state.projectsById.get(ACQ)!.correctionCap ?? 3,
  };
};

const automationInput = () => ({
  rules: state.instance.automation.rules.map((r) => ({ ...r })),
  prReview: {
    ...state.instance.automation.prReview,
    enabled: !state.instance.automation.prReview.enabled,
  },
});

const plugin = { url: "https://github.com/acme/review-kit", ref: "v1.2.0", subdir: null };
const storage = (over: { bucket?: string; endpoint?: string; secretAccessKey?: string } = {}) => ({
  endpoint: over.endpoint ?? state.instance.storage.endpoint,
  region: state.instance.storage.region,
  bucket: over.bucket ?? "stubwise-files-2",
  accessKeyId: state.instance.storage.accessKeyId,
  ...(over.secretAccessKey ? { secretAccessKey: over.secretAccessKey } : {}),
});
const webhook = { enabled: false, format: "discord" as const, url: null, events: {} };

/** Una richiesta di STW archiviata da Laura. */
async function archivedRequest(): Promise<Ctx> {
  as(LAURA);
  const r = await createRequest({ projectId: STW, title: "Old idea" });
  await archiveRequest(r.id);
  return { id: r.id };
}

/** Un commento di `author` sulla prima task di STW. */
const commentBy = (author: string) => async (): Promise<Ctx> => {
  as(author);
  const task = state.tasks.find((t) => t.projectId === STW)!;
  return { id: (await addComment(task.id, "Note")).id };
};

/** Marco fuori da ACQ: lo toglie Laura, con la riconferma. */
async function marcoOut(): Promise<void> {
  as(LAURA);
  markReauthenticated(LAURA);
  await admin.removeMember(ACQ, MARCO);
  resetReauth();
}
const resetReauth = () => state.reauth.clear();

const CASES: Case[] = [
  // --- Progetto → Settings -------------------------------------------------
  {
    name: "archiveProject",
    who: LAURA,
    pub: () => projectSettings.archiveProject(ACQ),
    sync: (me) => archiveProjectAs(me, ACQ),
    expected: "ok",
  },
  {
    name: "archiveProject senza permesso",
    who: SARA,
    pub: () => projectSettings.archiveProject(ACQ),
    sync: (me) => archiveProjectAs(me, ACQ),
    expected: "forbidden",
  },
  {
    name: "archiveProject già archiviato",
    who: GIULIA,
    pub: () => projectSettings.archiveProject(RNC),
    sync: (me) => archiveProjectAs(me, RNC),
    expected: "invalid",
  },
  {
    name: "reopenProject",
    who: GIULIA,
    pub: () => projectSettings.reopenProject(RNC),
    sync: (me) => reopenProjectAs(me, RNC),
    expected: "ok",
  },
  {
    name: "reopenProject su un attivo",
    who: LAURA,
    pub: () => projectSettings.reopenProject(ACQ),
    sync: (me) => reopenProjectAs(me, ACQ),
    expected: "invalid",
  },
  {
    name: "updateProjectGeneral",
    who: LAURA,
    pub: () => projectSettings.updateProjectGeneral(ACQ, { name: "Acquisti", description: "New" }),
    sync: (me) => updateProjectGeneralAs(me, ACQ, { name: "Acquisti", description: "New" }),
    expected: "ok",
  },
  {
    name: "updateProjectGeneral nome vuoto",
    who: LAURA,
    pub: () => projectSettings.updateProjectGeneral(ACQ, { name: " " }),
    sync: (me) => updateProjectGeneralAs(me, ACQ, { name: " " }),
    expected: "invalid",
  },
  {
    name: "updateProjectGeneral senza permesso",
    who: SARA,
    pub: () => projectSettings.updateProjectGeneral(ACQ, { name: "X" }),
    sync: (me) => updateProjectGeneralAs(me, ACQ, { name: "X" }),
    expected: "forbidden",
  },
  {
    name: "setProjectAi",
    who: LAURA,
    pub: () => projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: true }),
    sync: (me) => setProjectAiAs(me, ACQ, { providerId: "prv-backup-max", exclusive: true }),
    expected: "ok",
  },
  {
    name: "setProjectAi esclusivo senza account",
    who: LAURA,
    pub: () => projectSettings.setProjectAi(ACQ, { providerId: null, exclusive: true }),
    sync: (me) => setProjectAiAs(me, ACQ, { providerId: null, exclusive: true }),
    expected: "invalid",
  },
  {
    name: "saveProjectAutomations",
    who: LAURA,
    pub: () => projectSettings.saveProjectAutomations(ACQ, automationsInput(3)),
    sync: (me) => saveProjectAutomationsAs(me, ACQ, automationsInput(3)),
    expected: "ok",
  },
  {
    name: "saveProjectAutomations pulse fuori intervallo",
    who: LAURA,
    pub: () => projectSettings.saveProjectAutomations(ACQ, automationsInput(0)),
    sync: (me) => saveProjectAutomationsAs(me, ACQ, automationsInput(0)),
    expected: "invalid",
  },
  {
    name: "saveProjectAutomations senza permesso",
    who: SARA,
    pub: () => projectSettings.saveProjectAutomations(ACQ, automationsInput(3)),
    sync: (me) => saveProjectAutomationsAs(me, ACQ, automationsInput(3)),
    expected: "forbidden",
  },
  // --- Members ---------------------------------------------------------------
  {
    name: "addMember",
    who: LAURA,
    prep: marcoOut,
    reauth: true,
    pub: () => admin.addMember(ACQ, MARCO, roleIdOf("developer")),
    sync: (me) => addMemberAs(me, ACQ, MARCO, roleIdOf("developer")),
    expected: "ok",
  },
  {
    name: "addMember senza riconferma",
    who: LAURA,
    prep: marcoOut,
    pub: () => admin.addMember(ACQ, MARCO, roleIdOf("developer")),
    sync: (me) => addMemberAs(me, ACQ, MARCO, roleIdOf("developer")),
    expected: "reauth_required",
  },
  {
    name: "addMember di un full admin",
    who: LAURA,
    reauth: true,
    pub: () => admin.addMember(ACQ, ROBERTA, roleIdOf("developer")),
    sync: (me) => addMemberAs(me, ACQ, ROBERTA, roleIdOf("developer")),
    expected: "invalid",
  },
  {
    name: "addMember senza permesso",
    who: SARA,
    prep: marcoOut,
    reauth: true,
    pub: () => admin.addMember(ACQ, MARCO, roleIdOf("developer")),
    sync: (me) => addMemberAs(me, ACQ, MARCO, roleIdOf("developer")),
    expected: "forbidden",
  },
  {
    name: "removeMember",
    who: LAURA,
    reauth: true,
    pub: () => admin.removeMember(ACQ, MARCO),
    sync: (me) => removeMemberAs(me, ACQ, MARCO),
    expected: "ok",
  },
  {
    name: "removeMember senza riconferma",
    who: LAURA,
    pub: () => admin.removeMember(ACQ, MARCO),
    sync: (me) => removeMemberAs(me, ACQ, MARCO),
    expected: "reauth_required",
  },
  {
    name: "setMemberRole",
    who: LAURA,
    reauth: true,
    pub: () => admin.setMemberRole(ACQ, MARCO, roleIdOf("viewer")),
    sync: (me) => setMemberRoleAs(me, ACQ, MARCO, roleIdOf("viewer")),
    expected: "ok",
  },
  {
    name: "setMemberRole senza riconferma",
    who: LAURA,
    pub: () => admin.setMemberRole(ACQ, MARCO, roleIdOf("viewer")),
    sync: (me) => setMemberRoleAs(me, ACQ, MARCO, roleIdOf("viewer")),
    expected: "reauth_required",
  },
  {
    name: "setMemberRole ruolo che non c'è",
    who: LAURA,
    reauth: true,
    pub: () => admin.setMemberRole(ACQ, MARCO, "role-nope"),
    sync: (me) => setMemberRoleAs(me, ACQ, MARCO, "role-nope"),
    expected: "invalid",
  },
  // --- Istanza ---------------------------------------------------------------
  {
    name: "setModel",
    who: ROBERTA,
    pub: () => instance.setModel("triage", "opus"),
    sync: (me) => setModelAs(me, "triage", "opus"),
    expected: "ok",
  },
  {
    name: "setModel senza permesso",
    who: MARCO,
    pub: () => instance.setModel("triage", "opus"),
    sync: (me) => setModelAs(me, "triage", "opus"),
    expected: "forbidden",
  },
  {
    name: "setModel modello che non c'è",
    who: ROBERTA,
    pub: () => instance.setModel("triage", "gpt" as never),
    sync: (me) => setModelAs(me, "triage", "gpt" as never),
    expected: "invalid",
  },
  {
    name: "saveBudget",
    who: ROBERTA,
    pub: () => instance.saveBudget({ monthlyUsd: 800, contentLanguage: "it" }),
    sync: (me) => saveBudgetAs(me, { monthlyUsd: 800, contentLanguage: "it" }),
    expected: "ok",
  },
  {
    name: "saveBudget negativo",
    who: ROBERTA,
    pub: () => instance.saveBudget({ monthlyUsd: -1, contentLanguage: "en" }),
    sync: (me) => saveBudgetAs(me, { monthlyUsd: -1, contentLanguage: "en" }),
    expected: "invalid",
  },
  {
    name: "saveBudget senza permesso",
    who: MARCO,
    pub: () => instance.saveBudget({ monthlyUsd: 800, contentLanguage: "en" }),
    sync: (me) => saveBudgetAs(me, { monthlyUsd: 800, contentLanguage: "en" }),
    expected: "forbidden",
  },
  {
    name: "saveAutomation",
    who: ROBERTA,
    pub: () => instance.saveAutomation(automationInput()),
    sync: (me) => saveAutomationAs(me, automationInput()),
    expected: "ok",
  },
  {
    name: "saveAutomation senza righe",
    who: ROBERTA,
    pub: () => instance.saveAutomation({ ...automationInput(), rules: [] }),
    sync: (me) => saveAutomationAs(me, { ...automationInput(), rules: [] }),
    expected: "invalid",
  },
  {
    name: "setProviderEnabled",
    who: ROBERTA,
    pub: () => instance.setProviderEnabled("prv-backup-max", false),
    sync: (me) => setProviderEnabledAs(me, "prv-backup-max", false),
    expected: "ok",
  },
  {
    name: "setProviderEnabled senza permesso",
    who: MARCO,
    pub: () => instance.setProviderEnabled("prv-backup-max", false),
    sync: (me) => setProviderEnabledAs(me, "prv-backup-max", false),
    expected: "forbidden",
  },
  {
    name: "moveProvider",
    who: ROBERTA,
    pub: () => instance.moveProvider("prv-billing-key", 0),
    sync: (me) => moveProviderAs(me, "prv-billing-key", 0),
    expected: "ok",
  },
  {
    name: "moveProvider fuori elenco",
    who: ROBERTA,
    pub: () => instance.moveProvider("prv-billing-key", 9),
    sync: (me) => moveProviderAs(me, "prv-billing-key", 9),
    expected: "invalid",
  },
  {
    name: "updateGitAccount",
    who: ROBERTA,
    pub: () => instance.updateGitAccount(BITBUCKET, { name: "BB Audin", workspace: "audin2" }),
    sync: (me) => updateGitAccountAs(me, BITBUCKET, { name: "BB Audin", workspace: "audin2" }),
    expected: "ok",
  },
  {
    name: "updateGitAccount nome vuoto",
    who: ROBERTA,
    pub: () => instance.updateGitAccount(BITBUCKET, { name: "" }),
    sync: (me) => updateGitAccountAs(me, BITBUCKET, { name: "" }),
    expected: "invalid",
  },
  {
    name: "updateGitAccount senza permesso",
    who: MARCO,
    pub: () => instance.updateGitAccount(BITBUCKET, { name: "BB" }),
    sync: (me) => updateGitAccountAs(me, BITBUCKET, { name: "BB" }),
    expected: "forbidden",
  },
  {
    name: "setDefaultReviewer",
    who: ROBERTA,
    pub: () => instance.setDefaultReviewer(BITBUCKET, true),
    sync: (me) => setDefaultReviewerAs(me, BITBUCKET, true),
    expected: "ok",
  },
  {
    name: "setDefaultReviewer senza permesso",
    who: MARCO,
    pub: () => instance.setDefaultReviewer(BITBUCKET, true),
    sync: (me) => setDefaultReviewerAs(me, BITBUCKET, true),
    expected: "forbidden",
  },
  {
    name: "updateGoogleApp",
    who: ROBERTA,
    pub: () => instance.updateGoogleApp("gw-example", { name: "Example Inc" }),
    sync: (me) => updateGoogleAppAs(me, "gw-example", { name: "Example Inc" }),
    expected: "ok",
  },
  {
    name: "updateGoogleApp client id vuoto",
    who: ROBERTA,
    pub: () => instance.updateGoogleApp("gw-example", { clientId: " " }),
    sync: (me) => updateGoogleAppAs(me, "gw-example", { clientId: " " }),
    expected: "invalid",
  },
  {
    name: "updateGoogleApp senza permesso",
    who: MARCO,
    pub: () => instance.updateGoogleApp("gw-example", { name: "Example Inc" }),
    sync: (me) => updateGoogleAppAs(me, "gw-example", { name: "Example Inc" }),
    expected: "forbidden",
  },
  {
    name: "registerPlugin",
    who: ROBERTA,
    reauth: true,
    pub: () => instance.registerPlugin({ ...plugin, trusted: true }),
    sync: (me) => registerPluginAs(me, { ...plugin, trusted: true }),
    expected: "ok",
  },
  {
    name: "registerPlugin senza riconferma",
    who: ROBERTA,
    pub: () => instance.registerPlugin({ ...plugin, trusted: true }),
    sync: (me) => registerPluginAs(me, { ...plugin, trusted: true }),
    expected: "reauth_required",
  },
  {
    name: "registerPlugin senza «Mi fido»",
    who: ROBERTA,
    reauth: true,
    pub: () => instance.registerPlugin({ ...plugin, trusted: false as true }),
    sync: (me) => registerPluginAs(me, { ...plugin, trusted: false as true }),
    expected: "invalid",
  },
  {
    name: "registerPlugin senza permesso",
    who: MARCO,
    reauth: true,
    pub: () => instance.registerPlugin({ ...plugin, trusted: true }),
    sync: (me) => registerPluginAs(me, { ...plugin, trusted: true }),
    expected: "forbidden",
  },
  {
    name: "updatePluginRef",
    who: ROBERTA,
    reauth: true,
    pub: () => instance.updatePluginRef("plg-superpowers", { ref: "v9", trusted: true }),
    sync: (me) => updatePluginRefAs(me, "plg-superpowers", { ref: "v9", trusted: true }),
    expected: "ok",
  },
  {
    name: "updatePluginRef senza riconferma",
    who: ROBERTA,
    pub: () => instance.updatePluginRef("plg-superpowers", { ref: "v9", trusted: true }),
    sync: (me) => updatePluginRefAs(me, "plg-superpowers", { ref: "v9", trusted: true }),
    expected: "reauth_required",
  },
  {
    name: "rerunSmoke",
    who: ROBERTA,
    pub: () => instance.rerunSmoke("plg-superpowers"),
    sync: (me) => rerunSmokeAs(me, "plg-superpowers"),
    expected: "ok",
  },
  {
    name: "rerunSmoke su un plugin non pronto",
    who: ROBERTA,
    pub: () => instance.rerunSmoke("plg-lint-helpers"),
    sync: (me) => rerunSmokeAs(me, "plg-lint-helpers"),
    expected: "invalid",
  },
  {
    name: "removePlugin",
    who: ROBERTA,
    pub: () => instance.removePlugin("plg-lint-helpers"),
    sync: (me) => removePluginAs(me, "plg-lint-helpers"),
    expected: "ok",
  },
  {
    name: "removePlugin senza permesso",
    who: MARCO,
    pub: () => instance.removePlugin("plg-lint-helpers"),
    sync: (me) => removePluginAs(me, "plg-lint-helpers"),
    expected: "forbidden",
  },
  {
    name: "pauseQueue",
    who: ROBERTA,
    pub: () => instance.pauseQueue(ACQ),
    sync: (me) => pauseQueueAs(me, ACQ),
    expected: "ok",
  },
  {
    name: "pauseQueue già in pausa",
    who: ROBERTA,
    pub: () => instance.pauseQueue(STW),
    sync: (me) => pauseQueueAs(me, STW),
    expected: "invalid",
  },
  {
    name: "pauseQueue senza permesso",
    who: MARCO,
    pub: () => instance.pauseQueue(ACQ),
    sync: (me) => pauseQueueAs(me, ACQ),
    expected: "forbidden",
  },
  {
    name: "resumeQueue",
    who: ROBERTA,
    pub: () => instance.resumeQueue(STW),
    sync: (me) => resumeQueueAs(me, STW),
    expected: "ok",
  },
  {
    name: "resumeQueue non in pausa",
    who: ROBERTA,
    pub: () => instance.resumeQueue(ACQ),
    sync: (me) => resumeQueueAs(me, ACQ),
    expected: "invalid",
  },
  {
    name: "saveStorage",
    who: ROBERTA,
    pub: () => instance.saveStorage(storage()),
    sync: (me) => saveStorageAs(me, storage()),
    expected: "ok",
  },
  {
    name: "saveStorage con la chiave, senza riconferma",
    who: ROBERTA,
    pub: () => instance.saveStorage(storage({ secretAccessKey: "new-secret-1234" })),
    sync: (me) => saveStorageAs(me, storage({ secretAccessKey: "new-secret-1234" })),
    expected: "reauth_required",
  },
  {
    name: "saveStorage indirizzo non http",
    who: ROBERTA,
    pub: () => instance.saveStorage(storage({ endpoint: "ftp://x" })),
    sync: (me) => saveStorageAs(me, storage({ endpoint: "ftp://x" })),
    expected: "invalid",
  },
  {
    name: "saveStorage senza permesso",
    who: MARCO,
    pub: () => instance.saveStorage(storage()),
    sync: (me) => saveStorageAs(me, storage()),
    expected: "forbidden",
  },
  {
    name: "setAttachments",
    who: ROBERTA,
    pub: () => instance.setAttachments(false),
    sync: (me) => setAttachmentsAs(me, false),
    expected: "ok",
  },
  {
    name: "setAttachments senza permesso",
    who: MARCO,
    pub: () => instance.setAttachments(false),
    sync: (me) => setAttachmentsAs(me, false),
    expected: "forbidden",
  },
  {
    name: "saveWebhook",
    who: ROBERTA,
    pub: () => instance.saveWebhook(webhook),
    sync: (me) => saveWebhookAs(me, webhook),
    expected: "ok",
  },
  {
    name: "saveWebhook acceso senza indirizzo",
    who: ROBERTA,
    pub: () => instance.saveWebhook({ ...webhook, enabled: true }),
    sync: (me) => saveWebhookAs(me, { ...webhook, enabled: true }),
    expected: "invalid",
  },
  {
    name: "saveWebhook senza permesso",
    who: MARCO,
    pub: () => instance.saveWebhook(webhook),
    sync: (me) => saveWebhookAs(me, webhook),
    expected: "forbidden",
  },
  // --- Avvisi ----------------------------------------------------------------
  {
    name: "setSubscription",
    who: MARCO,
    pub: () => alerts.setSubscription(AUD, "release.failed", { app: true }),
    sync: (me) => setSubscriptionAs(me, AUD, "release.failed", { app: true }),
    expected: "ok",
  },
  {
    name: "setSubscription tipo che non c'è",
    who: MARCO,
    pub: () => alerts.setSubscription(AUD, "nope", { app: true }),
    sync: (me) => setSubscriptionAs(me, AUD, "nope", { app: true }),
    expected: "invalid",
  },
  {
    name: "setSubscription progetto che non c'è",
    who: MARCO,
    pub: () => alerts.setSubscription("prj-nope", "release.failed", { app: true }),
    sync: (me) => setSubscriptionAs(me, "prj-nope", "release.failed", { app: true }),
    expected: "not_found",
  },
  // --- Task, richieste, traguardi ---------------------------------------------
  {
    name: "reopenRequest",
    who: LAURA,
    prep: archivedRequest,
    pub: (ctx) => reopenRequest(ctx.id!),
    sync: (me, ctx) => reopenRequestAs(me, ctx.id!),
    expected: "ok",
  },
  {
    name: "reopenRequest senza backlog.edit",
    who: SARA,
    prep: archivedRequest,
    pub: (ctx) => reopenRequest(ctx.id!),
    sync: (me, ctx) => reopenRequestAs(me, ctx.id!),
    expected: "forbidden",
  },
  {
    name: "reopenRequest su una aperta",
    who: LAURA,
    prep: async () => {
      as(LAURA);
      return { id: (await createRequest({ projectId: STW, title: "Open" })).id };
    },
    pub: (ctx) => reopenRequest(ctx.id!),
    sync: (me, ctx) => reopenRequestAs(me, ctx.id!),
    expected: "invalid",
  },
  {
    name: "deleteComment dell'autore",
    who: SARA,
    prep: commentBy(SARA),
    pub: (ctx) => deleteComment(ctx.id!),
    sync: (me, ctx) => deleteCommentAs(me, ctx.id!),
    expected: "ok",
  },
  {
    name: "deleteComment altrui senza moderare",
    who: SARA,
    prep: commentBy(GIULIA),
    pub: (ctx) => deleteComment(ctx.id!),
    sync: (me, ctx) => deleteCommentAs(me, ctx.id!),
    expected: "forbidden",
  },
  {
    name: "deleteMilestone",
    who: GIULIA,
    pub: () => deleteMilestone("ms-mkx-1"),
    sync: (me) => deleteMilestoneAs(me, "ms-mkx-1"),
    expected: "ok",
  },
  {
    name: "deleteMilestone che chi agisce non vede",
    who: SARA,
    pub: () => deleteMilestone("ms-mkx-1"),
    sync: (me) => deleteMilestoneAs(me, "ms-mkx-1"),
    expected: "not_found",
  },
];

/** Lo stato del seme: i casi della tabella lo ripristinano da sé, due volte (`fresh`). */
const seed = () => {
  resetApi();
  setLatency(0);
};
afterEach(() => {
  resetApi();
  vi.useRealTimers();
});

describe("le forme sincrone fanno quello che fa la pubblica", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const ctxPub = await fresh(c);
    const pub = await effectOf(() => c.pub(ctxPub));

    const ctxSync = await fresh(c);
    expect(ctxSync).toEqual(ctxPub);
    const sync = syncEffectOf(() => c.sync(c.who, ctxSync));

    expect(verdict(pub.outcome)).toBe(c.expected);
    expect(sync.outcome).toEqual(pub.outcome);
    expect(sync.entries).toEqual(pub.entries);
    expect(sync.state).toBe(pub.state);
  });

  it("il confronto delle voci non è vuoto per costruzione: archiveProjectAs ne scrive una", async () => {
    const c = CASES.find((x) => x.name === "archiveProject")!;
    await fresh(c);
    const sync = syncEffectOf(() => c.sync(c.who, {}));
    expect(sync.entries).toMatchObject([{ kind: "project.archived", actorId: LAURA }]);
  });
});

describe("registerPluginAs e updatePluginRefAs chiedono la riconferma", () => {
  beforeEach(seed);

  it("senza riconferma: reauth_required, nessun plugin né passo del ciclo accodato", () => {
    vi.useFakeTimers();
    as(ROBERTA);
    const before = digest();
    expect(registerPluginAs(ROBERTA, { ...plugin, trusted: true })).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(updatePluginRefAs(ROBERTA, "plg-superpowers", { ref: "v9", trusted: true })).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(digest()).toBe(before);
    // Nessun passo del ciclo (materializzazione o smoke) in attesa.
    expect(vi.getTimerCount()).toBe(0);
    expect(state.instance.plugins.find((p) => p.id === "plg-superpowers")).toMatchObject({
      status: "ready",
    });
    // Il conteggio vede davvero il ciclo: con la riconferma il passo parte.
    markReauthenticated(ROBERTA);
    expect(registerPluginAs(ROBERTA, { ...plugin, trusted: true })).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("retryJobAs", () => {
  beforeEach(seed);

  it("apre la sessione senza farla partire: nessun evento, nessuna attesa", () => {
    as(ROBERTA);
    const result = retryJobAs(ROBERTA, "cv-run-acq-3");
    expect(result instanceof Promise).toBe(false);
    expect(result).toMatchObject({ ok: true, conversationId: expect.any(String) });
    const id = (result as { conversationId: string }).conversationId;
    const run = state.conversations.find((c) => c.id === id)!;
    expect(run).toMatchObject({
      kind: "task_run",
      taskId: "t-acq-3",
      ownerId: ROBERTA,
      state: "working",
    });
    expect(state.conversationEvents.get(id)).toEqual([]);
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toMatchObject([
      { actorId: ROBERTA, projectId: ACQ, object: { type: "task", id: "t-acq-3" } },
    ]);
  });

  it("i rifiuti sono quelli della pubblica: not_found, forbidden, not_retryable, conflict", async () => {
    as(MARCO);
    expect(retryJobAs(MARCO, "cv-run-acq-3")).toEqual(await instance.retryJob("cv-run-acq-3"));
    expect(retryJobAs(MARCO, "cv-nope")).toEqual({ ok: false, error: "not_found" });
    as(ROBERTA);
    expect(retryJobAs(ROBERTA, "cv-run-aud-5")).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_retryable",
    });
    expect(retryJobAs(ROBERTA, "cv-run-acq-3")).toMatchObject({ ok: true });
    // La sessione appena aperta è un lavoro vivo: un secondo Retry è un conflitto.
    expect(retryJobAs(ROBERTA, "cv-run-acq-3")).toEqual({ ok: false, error: "conflict" });
  });

  it("la pubblica la fa ancora partire: con Roberta si ferma al piano come oggi", async () => {
    as(ROBERTA);
    const result = await instance.retryJob("cv-run-acq-3");
    expect(result).toMatchObject({ ok: true });
    const id = (result as { conversationId: string }).conversationId;
    expect(state.conversationEvents.get(id)!.length).toBeGreaterThan(0);
    await whenIdle(id);
    expect(state.changelog.filter((e) => e.kind === "job.retried")).toHaveLength(1);
  });
});
