import { beforeEach, describe, expect, it } from "vitest";
import { ACTIONS, actionById } from "../../domain/access/actions";
import i18n from "../../i18n";
import { accessState } from "../access/index";
import { __secretValuesForTest } from "../admin/secrets";
import { automations, resetApi, setLatency } from "../api";
import { addComment, applyActions, askDecision, createTaskAs } from "../api-mutations";
import { supportState } from "../../domain/support/state";
import { markReauthenticated, REAUTH_REQUIRED } from "../auth/reauth";
import type { ProposedAction } from "../model";
import { settingsOf } from "../projectSettings/reads";
import { capOf } from "../releases/visibility";
import { AUTOMATION_CASES } from "../seed/automations";
import { setSessionPersonId } from "../session";
import {
  eventsOf,
  heldAutomationSignals,
  onAutomationSignal,
  state,
  storeGeneration,
  visibleProjectIds,
  type AutomationSignal,
} from "../store";
import { whenIdle } from "../stream";
import { CLAUDE_CATALOG, declaredClassOf, isCatalogFn, type CatalogRun } from "./catalog";
import type { ClaudeActionFn } from "./types";

const TYPES_SOURCE = Object.values(
  import.meta.glob("./types.ts", { query: "?raw", import: "default", eager: true }),
)[0] as string;

// Il catalogo delle azioni di Claude (area 10a, Task 4): l'elenco chiuso di
// ciò che il riquadro può fare, ognuna con la scrittura che la pagina usa
// già (`…As`), la classe di partenza, l'inverso e il «Who?». E l'esecutore
// unico del «tutto o niente» (`applyActions`), che ora copre anche
// impostazioni, accessi e registro, trattiene i segnali delle automazioni
// fino al gruppo riuscito e rimanda il lavoro da far partire (`after`).
//
// Persone del seme: Roberta (full admin), Giulia (Project Lead in OLV e MKX,
// Contributor in AUD), Marco (Developer in OLV), Matteo (iscritto alle task
// nuove di AUD).

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const MARCO = "p-marco";
const OLV = "prj-olv";
const MKX = "prj-mkx";
const ACQ = "prj-acq";
const RNC = "prj-rnc";
const STW = "prj-stw";
const FAILED_RUN = "cv-run-acq-3";
const STW_DRAFT = AUTOMATION_CASES.automations.draft;

const as = (personId: string) => setSessionPersonId(personId);
const action = (fn: ProposedAction["fn"], args: Record<string, unknown>): ProposedAction => ({
  fn,
  args,
  summary: fn,
});
/** Un'azione che fallisce sempre (`invalid: title`), senza scrivere niente. */
const failing = (): ProposedAction => action("createTask", { projectId: MKX, title: "  " });
const fns = Object.keys(CLAUDE_CATALOG) as ClaudeActionFn[];
const NO_WHO: readonly ClaudeActionFn[] = ["setSubscription", "saveFilter", "deleteFilter"];
const olvTaskId = () => state.tasks.find((t) => t.projectId === OLV)!.id;

beforeEach(() => {
  resetApi();
  setLatency(0);
  as(ROBERTA);
});

describe("il registro del catalogo", () => {
  it("ogni voce ha classe di partenza, «annullabile» e un «Who?» del catalogo dei permessi", () => {
    expect(fns.length).toBeGreaterThanOrEqual(38);
    for (const fn of fns) {
      const entry = CLAUDE_CATALOG[fn];
      expect(entry.fn, fn).toBe(fn);
      expect(["A", "B"], fn).toContain(entry.baseClass);
      expect(typeof entry.undoable, fn).toBe("boolean");
      // Solo ciò che è solo tuo non chiede permessi: le iscrizioni (P19) e i filtri salvati (P4).
      if (NO_WHO.includes(fn)) expect(entry.whoAction, fn).toBeNull();
      else expect(actionById(entry.whoAction ?? ""), fn).toBeDefined();
    }
    expect(isCatalogFn("createTask")).toBe(true);
    expect(isCatalogFn("recordDecision")).toBe(false);
    expect(isCatalogFn("toString")).toBe(false);
  });

  it("le azioni nuove di «Who?» hanno la loro frase (commentTasks, sul permesso dei commenti)", () => {
    const used = new Set(fns.map((fn) => CLAUDE_CATALOG[fn].whoAction).filter((a) => a !== null));
    for (const id of used) {
      const a = ACTIONS.find((x) => x.id === id)!;
      expect(i18n.exists(a.labelKey, { lng: "en" }), id).toBe(true);
      expect(i18n.exists(a.labelKey, { lng: "it" }), id).toBe(true);
    }
    expect(actionById("commentTasks")).toMatchObject({
      permission: "tickets.comment",
      scope: "project",
    });
    expect(CLAUDE_CATALOG.addComment.whoAction).toBe("commentTasks");
    // I traguardi chiedono `tickets.edit`, che ha già la sua azione (P19).
    expect(CLAUDE_CATALOG.createMilestone.whoAction).toBe("editTasks");
    expect(CLAUDE_CATALOG.deleteMilestone.whoAction).toBe("editTasks");
  });

  it("la classe C viene SOLO da REAUTH_REQUIRED, e nessuna voce le sta sotto", () => {
    for (const fn of fns) {
      const reauth = REAUTH_REQUIRED.has(CLAUDE_CATALOG[fn].apiFn);
      expect(declaredClassOf(fn) === "C", fn).toBe(reauth);
      if (!reauth) expect(declaredClassOf(fn)).toBe(CLAUDE_CATALOG[fn].baseClass);
    }
    expect(fns.filter((fn) => declaredClassOf(fn) === "C").sort()).toEqual(
      [
        "addMember",
        "registerPlugin",
        "removeMember",
        "saveStorage",
        "setMemberRole",
        "updatePluginRef",
      ].sort(),
    );
  });

  it("nessuna voce che non si annulla parte in classe A", () => {
    for (const fn of fns) {
      if (!CLAUDE_CATALOG[fn].undoable) expect(CLAUDE_CATALOG[fn].baseClass, fn).toBe("B");
    }
  });

  it("le voci delle bozze di automazione (area 10b): classe, inverso, «Who?» di ACTIONS", () => {
    expect(CLAUDE_CATALOG.createAutomation).toMatchObject({
      apiFn: "automations.createAutomation",
      baseClass: "A",
      undoable: true,
      whoAction: "manageProjectAutomations",
    });
    expect(CLAUDE_CATALOG.saveAutomationDraft).toMatchObject({
      apiFn: "automations.saveDraft",
      baseClass: "A",
      undoable: true,
      whoAction: "manageProjectAutomations",
    });
    expect(CLAUDE_CATALOG.deleteAutomationDraft).toMatchObject({
      apiFn: "automations.deleteDraft",
      baseClass: "B",
      undoable: false,
      whoAction: "manageProjectAutomations",
    });
    expect(actionById("manageProjectAutomations")).toMatchObject({
      permission: "automations.manage",
      scope: "project",
    });
    // Nessuna voce accende o pubblica (maintainer).
    for (const fn of fns) {
      expect(CLAUDE_CATALOG[fn].apiFn, fn).not.toBe("automations.activate");
      expect(CLAUDE_CATALOG[fn].apiFn, fn).not.toBe("automations.publish");
    }
  });

  it("i tipi stanno in una foglia senza import (P10)", () => {
    expect(TYPES_SOURCE).toContain("export type ClaudeActionFn");
    expect(TYPES_SOURCE).not.toMatch(/^\s*import\b/m);
    expect(TYPES_SOURCE).not.toMatch(/\bfrom\s+["']/);
  });
});

// --- gli inversi --------------------------------------------------------------------

/** Un caso per voce: gli argomenti su uno stato appena ripristinato, come Roberta (full admin, riconferma fresca). */
const SCENARIOS: Partial<Record<ClaudeActionFn, () => Record<string, unknown>>> = {
  createTask: () => ({ projectId: OLV, title: "Prova" }),
  updateTask: () => ({ id: olvTaskId(), patch: { title: "Titolo nuovo" } }),
  planTask: () => ({ id: olvTaskId(), plan: { assigneeId: MARCO, week: null } }),
  addComment: () => ({ taskId: olvTaskId(), body: "Ciao" }),
  deleteComment: () => ({ id: "act-t-aud-1-c1" }),
  createRequest: () => ({ projectId: OLV, title: "Una richiesta" }),
  archiveRequest: () => ({ id: "req-aud-2" }),
  reopenRequest: () => ({ id: "req-stw-3" }),
  createMilestone: () => ({ projectId: OLV, name: "Raccolta" }),
  deleteMilestone: () => ({ id: "ms-aud-1" }),
  archiveProject: () => ({ projectId: OLV }),
  reopenProject: () => ({ projectId: RNC }),
  addMember: () => ({ projectId: OLV, personId: "p-laura", roleId: "role-developer" }),
  removeMember: () => ({ projectId: OLV, personId: "p-davide" }),
  setMemberRole: () => ({ projectId: OLV, personId: "p-davide", roleId: "role-developer" }),
  updateProjectGeneral: () => ({ projectId: OLV, name: "Olive" }),
  setProjectAi: () => ({ projectId: OLV, providerId: "prv-backup-max", exclusive: false }),
  saveProjectAutomations: () => {
    const p = state.projectsById.get(MKX)!;
    const s = settingsOf(p);
    return {
      projectId: MKX,
      switches: { ...s.switches },
      pulseEveryDays: s.pulseEveryDays === 5 ? 6 : 5,
      correctionCap: capOf(MKX),
    };
  },
  setModel: () => ({ operation: "fix_plan", model: "sonnet" }),
  saveBudget: () => ({ monthlyUsd: 800, contentLanguage: "it" }),
  saveAutomation: () => {
    const a = structuredClone(state.instance.automation);
    return { rules: a.rules, prReview: { ...a.prReview, enabled: !a.prReview.enabled } };
  },
  setProviderEnabled: () => ({ id: "prv-backup-max", enabled: false }),
  moveProvider: () => ({ id: "prv-billing-key", toIndex: 0 }),
  updateGitAccount: () => ({ id: "git-github-shop", name: "Shop two" }),
  setDefaultReviewer: () => ({ id: "git-github-shop", on: true }),
  updateGoogleApp: () => ({ id: "gw-example", name: "Example two" }),
  registerPlugin: () => ({
    url: "https://github.com/acme/review-kit",
    ref: "v1.2.0",
    subdir: null,
    trusted: true,
  }),
  rerunSmoke: () => ({ id: "plg-superpowers" }),
  removePlugin: () => ({ id: "plg-lint-helpers" }),
  pauseQueue: () => ({ projectId: OLV }),
  resumeQueue: () => ({ projectId: STW }),
  retryJob: () => ({ jobId: FAILED_RUN }),
  saveStorage: () => ({ ...storageArgs(), bucket: "stubwise-files-2" }),
  setAttachments: () => ({ on: false }),
  saveWebhook: () => ({ ...webhookArgs(), enabled: false }),
  setSubscription: () => ({ projectId: "prj-aud", type: "task.created", app: true }),
  // Le bozze di automazione (area 10b, Task 3): una bozza di STW c'è già.
  createAutomation: () => ({ projectId: ACQ, name: "Prova", flow: draftFlow() }),
  saveAutomationDraft: () => ({ id: STW_DRAFT, flow: draftFlow() }),
  // Il filtro salvato personale (area 10b, Task 9): nasce privato.
  saveFilter: () => ({
    name: "Marco in ACQ",
    criteria: { projectIds: [ACQ], assigneeIds: [MARCO], families: ["todo", "active"] },
  }),
};

/** Un flusso senza problemi per una bozza nuova (`createAutomation` valida prima di scrivere). */
const draftFlow = () => ({
  trigger: { kind: "stubwise", event: "request_created" },
  titleTemplate: "{{richiesta.codice}}",
  steps: [
    {
      id: "n",
      kind: "notify",
      who: { departmentId: "dep-support" },
      text: "Nuova richiesta",
      approval: { mode: "auto" },
    },
  ],
});

const storageArgs = () => {
  const s = state.instance.storage;
  return { endpoint: s.endpoint, region: s.region, bucket: s.bucket, accessKeyId: s.accessKeyId };
};
const webhookArgs = () => {
  const w = state.instance.webhook;
  return { enabled: w.enabled, format: w.format, url: w.url, events: { ...w.events } };
};

describe("gli inversi", () => {
  it.each(Object.keys(SCENARIOS) as ClaudeActionFn[])(
    "%s: l'inverso c'è solo se la voce si annulla, è una voce del catalogo e si esegue",
    (fn) => {
      markReauthenticated(ROBERTA);
      const run: CatalogRun = CLAUDE_CATALOG[fn].run(ROBERTA, SCENARIOS[fn]!());
      expect(run.inverse !== null).toBe(CLAUDE_CATALOG[fn].undoable);
      expect(run.objects.length).toBeGreaterThan(0);
      if (run.inverse === null) return;
      expect(isCatalogFn(run.inverse.fn)).toBe(true);
      expect(() => CLAUDE_CATALOG[run.inverse!.fn].run(ROBERTA, run.inverse!.args)).not.toThrow();
    },
  );

  it("ogni voce che si annulla ha il suo caso qui sopra", () => {
    const missing = fns.filter((fn) => CLAUDE_CATALOG[fn].undoable && !SCENARIOS[fn]);
    expect(missing).toEqual([]);
  });

  /** Esegue l'azione e poi il suo inverso, ognuna come gruppo di una sola. */
  function doAndUndo(fn: ClaudeActionFn, args: Record<string, unknown>): void {
    const done = applyActions(ROBERTA, [action(fn, args)], { catalogOnly: true });
    if (!done.ok) throw new Error(`not done: ${done.code}`);
    const inverse = done.catalogRuns[0]!.inverse!;
    const undone = applyActions(ROBERTA, [action(inverse.fn, inverse.args)], { catalogOnly: true });
    expect(undone.ok).toBe(true);
  }

  it("moveProvider annullato rimette l'ordine", () => {
    const before = state.instance.providers.map((p) => p.id);
    doAndUndo("moveProvider", { id: "prv-billing-key", toIndex: 0 });
    expect(state.instance.providers.map((p) => p.id)).toEqual(before);
  });

  it("setDefaultReviewer annullato rimette il revisore di prima, anche quando non c'era", () => {
    const reviewers = () =>
      state.instance.gitAccounts.filter((a) => a.defaultReviewer).map((a) => a.id);
    expect(reviewers()).toEqual(["git-github-stubwise"]);
    doAndUndo("setDefaultReviewer", { id: "git-github-shop", on: true });
    expect(reviewers()).toEqual(["git-github-stubwise"]);
    // Nessun revisore nell'ambito di Bitbucket: annullare lo rispegne.
    doAndUndo("setDefaultReviewer", { id: "git-bitbucket-audin", on: true });
    expect(reviewers()).toEqual(["git-github-stubwise"]);
    // Spento: annullare lo riaccende.
    doAndUndo("setDefaultReviewer", { id: "git-github-stubwise", on: false });
    expect(reviewers()).toEqual(["git-github-stubwise"]);
  });

  it("saveBudget annullato rimette budget E lingua dei contenuti", () => {
    const before = structuredClone(state.instance.budget);
    doAndUndo("saveBudget", { monthlyUsd: 900, contentLanguage: "it" });
    expect(state.instance.budget).toEqual(before);
  });

  it("pauseQueue annullato riprende la coda", () => {
    doAndUndo("pauseQueue", { projectId: OLV });
    expect(state.instance.queuePauses.some((p) => p.projectId === OLV)).toBe(false);
  });
});

describe("nessun segreto dal riquadro", () => {
  it("saveStorage con una chiave negli argomenti è `invalid` prima di ogni scrittura", () => {
    markReauthenticated(ROBERTA);
    const storage = structuredClone(state.instance.storage);
    const vault = __secretValuesForTest();
    const changes = state.changelog.length;
    const result = applyActions(
      ROBERTA,
      [action("saveStorage", { ...storageArgs(), bucket: "other", secretAccessKey: "s3cr3t-key" })],
      { catalogOnly: true },
    );
    expect(result).toMatchObject({ ok: false, index: 0, code: "invalid" });
    expect(state.instance.storage).toEqual(storage);
    expect(__secretValuesForTest()).toEqual(vault);
    expect(state.changelog).toHaveLength(changes);
    expect(() =>
      CLAUDE_CATALOG.saveStorage.run(ROBERTA, { ...storageArgs(), secretAccessKey: "x" }),
    ).toThrow("invalid: secret_access_key");
  });

  it("il suo inverso rimette endpoint, regione, bucket e access key id, mai la chiave", () => {
    const before = storageArgs();
    const run = CLAUDE_CATALOG.saveStorage.run(ROBERTA, { ...before, bucket: "b-2" });
    expect(state.instance.storage.bucket).toBe("b-2");
    expect(run.inverse).toEqual({ fn: "saveStorage", args: before });
  });
});

// --- applyActions: tutto o niente -------------------------------------------------

describe("applyActions col catalogo: tutto o niente", () => {
  it("archiveProject seguito da un fallimento: lo stato torna com'era, e nessuna voce resta nel registro", () => {
    const changes = state.changelog.length;
    const result = applyActions(ROBERTA, [action("archiveProject", { projectId: OLV }), failing()]);
    expect(result).toMatchObject({ ok: false, index: 1, code: "invalid" });
    expect(state.projectsById.get(OLV)!.archived).toBeFalsy();
    expect(state.changelog).toHaveLength(changes);
  });

  it("addMember seguito da un fallimento: gli accessi sono lo stesso oggetto, con le stesse appartenenze", () => {
    markReauthenticated(ROBERTA);
    const access = accessState();
    const memberships = structuredClone(access.memberships);
    const members = [...state.projectsById.get(OLV)!.memberIds];
    const result = applyActions(ROBERTA, [
      action("addMember", { projectId: OLV, personId: "p-laura", roleId: "role-developer" }),
      failing(),
    ]);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(accessState()).toBe(access);
    expect(state.access).toBe(access);
    expect(accessState().memberships).toEqual(memberships);
    expect(state.projectsById.get(OLV)!.memberIds).toEqual(members);
  });

  it("deleteTask seguito da un fallimento: la task ritrova attività, decisioni e sistemazioni", async () => {
    const task = createTaskAs(ROBERTA, {
      projectId: OLV,
      title: "Da decidere",
      assigneeId: ROBERTA,
    });
    await askDecision({
      taskId: task.id,
      askedOfId: MARCO,
      question: "Quale?",
      options: ["A", "B"],
    });
    await addComment(task.id, "Un commento");
    const before = structuredClone({
      decisions: state.decisions,
      activity: state.activity,
      arrangements: state.arrangements,
      deletedTasks: state.deletedTasks,
    });
    expect(before.decisions.some((d) => d.taskId === task.id)).toBe(true);
    const result = applyActions(ROBERTA, [action("deleteTask", { id: task.id }), failing()]);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(state.tasksById.has(task.id)).toBe(true);
    expect({
      decisions: state.decisions,
      activity: state.activity,
      arrangements: state.arrangements,
      deletedTasks: state.deletedTasks,
    }).toEqual(before);
  });

  it("createRequest da una conversazione di Support seguito da un fallimento: la conversazione resta senza richiesta", () => {
    const conv = state.supportConversations.find(
      (c) =>
        c.requestId === null &&
        supportState(c) === "not_concluded" &&
        visibleProjectIds(ROBERTA).has(c.projectId),
    )!;
    expect(conv).toBeDefined();
    const result = applyActions(ROBERTA, [
      action("createRequest", {
        projectId: conv.projectId,
        title: "Dal cliente",
        origin: { kind: "support", conversationId: conv.id },
      }),
      failing(),
    ]);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(state.supportConversations.find((c) => c.id === conv.id)!.requestId).toBeNull();
  });

  it("setSubscription seguito da un fallimento: iscrizioni e ordine degli avvisi come prima", () => {
    const subs = structuredClone(state.alertSubscriptions);
    const seq = state.alertSeq;
    const result = applyActions(ROBERTA, [
      action("setSubscription", { projectId: "prj-aud", type: "task.created", app: true }),
      failing(),
    ]);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(state.alertSubscriptions).toEqual(subs);
    expect(state.alertSeq).toBe(seq);
  });

  it("deleteTask occupato: `busy` con le ragioni", () => {
    const live = state.conversations.find(
      (c) => c.kind === "task_run" && c.state !== "finished" && c.taskId !== null,
    )!;
    const result = applyActions(ROBERTA, [action("deleteTask", { id: live.taskId })]);
    expect(result).toMatchObject({ ok: false, index: 0, code: "busy" });
    expect(!result.ok && result.reasons?.length).toBeGreaterThan(0);
    expect(state.tasksById.has(live.taskId!)).toBe(true);
  });

  it("addMember senza riconferma: `reauth_required`", () => {
    const result = applyActions(ROBERTA, [
      action("addMember", { projectId: OLV, personId: "p-laura", roleId: "role-developer" }),
    ]);
    expect(result).toMatchObject({ ok: false, index: 0, code: "reauth_required" });
  });

  it("con `catalogOnly` una funzione fuori dal catalogo è `invalid` senza scrivere; senza (la Posta) gira come oggi", () => {
    const decide = action("recordDecision", {
      projectId: OLV,
      title: "Olio nuovo",
      decision: "Si raccoglie a ottobre",
      source: "manual",
    });
    const log = state.decisionLog.length;
    const tasks = state.tasks.length;
    const refused = applyActions(
      ROBERTA,
      [action("createTask", { projectId: OLV, title: "Prima" }), decide],
      {
        catalogOnly: true,
      },
    );
    expect(refused).toEqual({ ok: false, index: 1, code: "invalid" });
    expect(state.decisionLog).toHaveLength(log);
    expect(state.tasks).toHaveLength(tasks);
    expect(applyActions(ROBERTA, [decide]).ok).toBe(true);
    expect(state.decisionLog).toHaveLength(log + 1);
  });

  it("un gruppo riuscito porta gli inversi in `catalogRuns` e la sessione di retryJob in `after`", async () => {
    const result = applyActions(
      ROBERTA,
      [
        action("createTask", { projectId: OLV, title: "Potatura" }),
        action("retryJob", { jobId: FAILED_RUN }),
      ],
      { catalogOnly: true },
    );
    if (!result.ok) throw new Error(result.code);
    const created = state.tasks.find((t) => t.title === "Potatura")!;
    expect(result.catalogRuns[0]).toMatchObject({
      inverse: { fn: "deleteTask", args: { id: created.id } },
      objects: [{ kind: "task", id: created.id }],
    });
    expect(result.catalogRuns[1]!.inverse).toBeNull();
    expect(result.after).toHaveLength(1);
    const session = state.conversations.at(-1)!;
    expect(session.projectId).toBe(ACQ);
    // Aperta, ma non partita: parte solo con `after`.
    expect(eventsOf(session.id)).toHaveLength(0);
    await result.after[0]!(storeGeneration());
    await whenIdle(session.id);
    expect(eventsOf(session.id).length).toBeGreaterThan(0);
  });

  it("retryJob in un gruppo che poi fallisce: nessuna sessione nasce né parte", () => {
    const conversations = state.conversations.map((c) => c.id);
    const events = state.conversationEvents.size;
    const result = applyActions(ROBERTA, [action("retryJob", { jobId: FAILED_RUN }), failing()]);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(state.conversations.map((c) => c.id)).toEqual(conversations);
    expect(state.conversationEvents.size).toBe(events);
  });
});

describe("createTask del catalogo: la scrittura vera, coi segnali trattenuti (P5)", () => {
  /** Un'automazione di Roberta che parte quando nasce una task in MKX (un passo che aspetta). */
  async function onTaskCreated(): Promise<string> {
    const a = await automations.createAutomation({
      name: "Nuove task",
      projectId: MKX,
      flow: {
        trigger: { kind: "stubwise", event: "task_created" },
        steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
        titleTemplate: "{{task.codice}}",
      },
    });
    await automations.activate(a.id);
    return a.id;
  }
  const runsOf = (id: string) => state.automationRuns.filter((r) => r.automationId === id);
  const createdAlerts = (title: string) =>
    state.notifications.filter(
      (n) =>
        n.kind === "task.created" &&
        state.tasks.some((t) => t.code === n.objectCode && t.title === title),
    );

  /** I segnali che arrivano davvero agli ascoltatori (gli inizi delle automazioni). */
  function delivered(): { signals: AutomationSignal[]; stop: () => void } {
    const signals: AutomationSignal[] = [];
    const stop = onAutomationSignal((s) => signals.push(s));
    return { signals, stop: () => void stop() };
  }

  it("a gruppo riuscito l'esecuzione parte e `task.created` è pubblicato", async () => {
    const id = await onTaskCreated();
    const spy = delivered();
    const result = applyActions(GIULIA, [
      action("createTask", { projectId: MKX, title: "Pagina nuova" }),
    ]);
    spy.stop();
    expect(result.ok).toBe(true);
    expect(spy.signals.map((s) => s.kind)).toEqual(["task_created"]);
    expect(runsOf(id)).toHaveLength(1);
    expect(createdAlerts("Pagina nuova")).toHaveLength(1);
    expect(heldAutomationSignals()).toEqual([]);
    await automations.whenAutomationsIdle();
  });

  it("seguito da un fallimento: nessuna esecuzione, nessun avviso, coda trattenuta vuota", async () => {
    const id = await onTaskCreated();
    const notifications = state.notifications.length;
    const spy = delivered();
    const result = applyActions(GIULIA, [
      action("createTask", { projectId: MKX, title: "Pagina nuova" }),
      failing(),
    ]);
    spy.stop();
    expect(result.ok).toBe(false);
    // Il segnale non è mai arrivato all'ascoltatore: il ripristino da solo
    // non fermerebbe l'esecuzione già messa in coda (P5).
    expect(spy.signals).toEqual([]);
    expect(runsOf(id)).toHaveLength(0);
    expect(state.notifications).toHaveLength(notifications);
    expect(heldAutomationSignals()).toEqual([]);
    await automations.whenAutomationsIdle();
    expect(runsOf(id)).toHaveLength(0);
  });

  it("una task nata assegnata a un altro gli manda `task.assigned` (I1 del Task 3)", () => {
    const result = applyActions(GIULIA, [
      action("createTask", { projectId: OLV, title: "Potare gli ulivi", assigneeId: MARCO }),
    ]);
    expect(result.ok).toBe(true);
    const task = state.tasks.find((t) => t.title === "Potare gli ulivi")!;
    expect(
      state.notifications.filter(
        (n) =>
          n.kind === "task.assigned" &&
          n.objectCode === task.code &&
          n.recipientIds.includes(MARCO),
      ),
    ).toHaveLength(1);
  });
});
