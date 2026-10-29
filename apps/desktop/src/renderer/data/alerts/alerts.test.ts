import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALERT_TYPES, isCatalogKind, registerAlertTypes } from "../../domain/alerts/catalog";
import { createTaskAs } from "../api-mutations";
import {
  alerts,
  automations,
  createTask,
  failNext,
  listNotifications,
  markNotification,
  resetApi,
  setLatency,
} from "../api";
import { presentChatNotification } from "../chat/reads";
import { ALERT_NOTIFICATIONS, ALERT_SUBSCRIPTIONS } from "../seed/alerts";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { AppNotification } from "../types";
import { grantProjectRole } from "../viewer";
import { publishAlert, releaseMandatory } from "./publish";

const AUD = "prj-aud";
const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);
const seedAlert = (kind: string) => ALERT_NOTIFICATIONS.find((n) => n.kind === kind)!;
/** Le notifiche di una persona, lette come le legge lei. */
const inbox = async (personId: string): Promise<AppNotification[]> => {
  as(personId);
  return listNotifications();
};
const has = async (personId: string, id: string) =>
  (await inbox(personId)).some((n) => n.id === id);
const lastId = () => state.notifications.at(-1)!.id;
/** Lo stesso avviso, pubblicato adesso (con i suoi obbligatori, o con quelli dati). */
const again = (n: AppNotification, mandatory: AppNotification["mandatory"] = n.mandatory) =>
  publishAlert({
    kind: n.kind,
    projectId: n.projectId!,
    objectCode: n.objectCode,
    title: n.title,
    body: n.body,
    link: n.link,
    mandatory,
  });

const failedV3 = seedAlert("release.failed"); // AUD-V3, Laura `merged`, 3 giorni fa
const analysis = seedAlert("pr.analysis_issues"); // audin-app#246, Marco `pr_author`
const prOpened = seedAlert("pr.opened"); // audin-app#244

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("avvisi: prima nessuno li vedeva, ora arrivano alle persone giuste", () => {
  it("ogni avviso del seme arriva a qualcuno", async () => {
    const people = ["p-giulia", "p-marco", "p-laura", "p-sara", "p-matteo", "p-roberta"];
    const seen = new Set<string>();
    for (const p of people) for (const n of await inbox(p)) seen.add(n.id);
    for (const n of ALERT_NOTIFICATIONS) expect(seen.has(n.id), n.kind).toBe(true);
  });

  it("chi riceve cosa, nel seme", async () => {
    // Rilascio fallito AUD-V3: Laura (merge), Matteo (Project Lead: default
    // acceso con release.merge), Giulia (iscritta al momento dell'avviso).
    expect(await has("p-laura", failedV3.id)).toBe(true);
    expect(await has("p-matteo", failedV3.id)).toBe(true);
    expect(await has("p-giulia", failedV3.id)).toBe(true);
    expect(await has("p-marco", failedV3.id)).toBe(false);
    // Nuova PR: solo chi l'ha accesa (Matteo).
    expect(await has("p-matteo", prOpened.id)).toBe(true);
    expect(await has("p-laura", prOpened.id)).toBe(false);
    // Il cliente ha risposto (ACQ-S2): chi risponde ai clienti, non Sara.
    const replied = seedAlert("support.customer_replied");
    expect(await has("p-laura", replied.id)).toBe(true);
    expect(await has("p-matteo", replied.id)).toBe(true);
    expect(await has("p-sara", replied.id)).toBe(false);
  });
});

describe("Review Focus 1: destinatari a lettura", () => {
  it("permesso revocato dopo l'avviso: sparisce; riacquistato: torna", async () => {
    expect(await has("p-marco", analysis.id)).toBe(true);
    grantProjectRole("p-marco", AUD, "contributor"); // niente repos.view
    expect(await has("p-marco", analysis.id)).toBe(false);
    grantProjectRole("p-marco", AUD, "developer");
    expect(await has("p-marco", analysis.id)).toBe(true);
  });

  it("iscrizione spenta dopo l'avviso: resta (Giulia, AUD-V3)", async () => {
    const giulia = ALERT_SUBSCRIPTIONS.find(
      (s) => s.personId === "p-giulia" && s.type === "release.failed",
    )!;
    expect(giulia.history.at(-1)!.app).toBe(false);
    expect(giulia.history.at(-1)!.at > failedV3.createdAt).toBe(true);
    expect(await has("p-giulia", failedV3.id)).toBe(true);
    // Un fallimento di adesso non le arriva più.
    again(failedV3, []);
    expect(await has("p-giulia", lastId())).toBe(false);
  });

  it("R-K19: iscriversi non porta gli avvisi già arrivati nella sessione", async () => {
    again(failedV3, []);
    const past = lastId();
    expect(await has("p-marco", past)).toBe(false);
    as("p-marco");
    await alerts.setSubscription(AUD, "release.failed", { app: true });
    expect(await has("p-marco", past)).toBe(false);
    again(failedV3, []);
    expect(await has("p-marco", lastId())).toBe(true);
  });

  it("progetto diventato invisibile: sparisce, anche se obbligatorio", async () => {
    expect(await has("p-laura", failedV3.id)).toBe(true);
    const aud = state.projectsById.get(AUD)!;
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-laura");
    expect(await has("p-laura", failedV3.id)).toBe(false);
  });

  it("avviso obbligatorio con l'iscrizione spenta: arriva comunque, col perché", async () => {
    as("p-laura");
    await expect(alerts.setSubscription(AUD, "release.failed", { app: false })).resolves.toBe(
      undefined,
    );
    again(failedV3, [{ personId: "p-laura", reason: "merged" }]);
    const mine = (await inbox("p-laura")).find((n) => n.id === lastId());
    expect(mine?.mandatory).toEqual([{ personId: "p-laura", reason: "merged" }]);
    // Senza obbligo, con l'iscrizione spenta, no.
    again(failedV3, []);
    expect(await has("p-laura", lastId())).toBe(false);
  });

  it("merge fuori da Stubwise da un'identità non collegata: l'autore della task, o nessuno", async () => {
    const v2 = state.releases.find((r) => r.code === "AUD-V2")!;
    expect(v2.mergedById).toBeNull();
    const mandatory = releaseMandatory(v2);
    expect(mandatory).toEqual([{ personId: "p-elena", reason: "task_author" }]);
    publishAlert({
      kind: "release.failed",
      projectId: AUD,
      objectCode: "AUD-V2",
      title: "Release failed",
      body: "",
      link: "#/p/AUD/releases",
      mandatory,
    });
    const elena = (await inbox("p-elena")).find((n) => n.id === lastId());
    expect(elena?.mandatory).toEqual([{ personId: "p-elena", reason: "task_author" }]);
    // Senza task collegata alla PR: nessun obbligato.
    expect(releaseMandatory({ ...v2, pr: { repo: "audin/audin-app", number: 241 } })).toEqual([]);
  });

  it("merge fuori da Stubwise da un nome git collegato: a chi l'ha fatto, non all'autore della task", async () => {
    const v2 = state.releases.find((r) => r.code === "AUD-V2")!;
    state.commitAuthorLinks.set(v2.mergedGitName, "p-stefano");
    const mandatory = releaseMandatory(v2);
    expect(mandatory).toEqual([{ personId: "p-stefano", reason: "merged" }]);
    publishAlert({
      kind: "release.failed",
      projectId: AUD,
      objectCode: "AUD-V2",
      title: "Release failed",
      body: "",
      link: "#/p/AUD/releases",
      mandatory,
    });
    const stefano = (await inbox("p-stefano")).find((n) => n.id === lastId());
    expect(stefano?.mandatory).toEqual([{ personId: "p-stefano", reason: "merged" }]);
    expect(await has("p-elena", lastId())).toBe(false);
  });

  it("Claude non riceve mai avvisi, nemmeno obbligatori (R-K5)", async () => {
    again(analysis, [{ personId: "p-claude", reason: "pr_author" }]);
    expect(await has("p-claude", lastId())).toBe(false);
    expect((await inbox("p-claude")).some((n) => n.recipientIds.length === 0)).toBe(false);
  });
});

describe("task.created: una task nuova avvisa chi l'ha accesa", () => {
  it("Matteo (iscritto in AUD) riceve la task che Laura crea; Marco (spento) no", async () => {
    as("p-laura");
    const task = await createTask({ projectId: AUD, title: "Store review notes" });
    const n = state.notifications.find(
      (x) => x.kind === "task.created" && x.objectCode === task.code,
    );
    expect(n).toMatchObject({ link: `#/p/AUD/tasks?task=${task.code}`, recipientIds: [] });
    expect(await has("p-matteo", n!.id)).toBe(true);
    expect(await has("p-marco", n!.id)).toBe(false);
  });
});

describe("task.created_by_automation: le task delle Automazioni, sempre all'assegnatario", () => {
  /**
   * Un'automazione di Roberta (manuale, in `projectId`) crea una task per
   * `assigneeId`: la si esegue e si restituisce la task creata.
   */
  async function byAutomation(assigneeId: string, projectId = AUD) {
    as("p-roberta");
    const a = await automations.createAutomation({
      name: "Prova",
      projectId,
      flow: {
        trigger: { kind: "manual" },
        titleTemplate: "Prova",
        steps: [
          {
            id: "t",
            kind: "createTask",
            title: "Preparare il contratto",
            description: "",
            assignee: { personId: assigneeId },
            dueInDays: null,
            project: { mode: "own" },
            milestoneRef: null,
            approval: { mode: "auto" },
          },
        ],
      },
    });
    await automations.activate(a.id);
    await automations.startManual(a.id);
    await automations.whenAutomationsIdle();
    return state.tasks.find((t) => t.automationRef?.automationId === a.id)!;
  }
  const alertsOf = (code: string) => state.notifications.filter((n) => n.objectCode === code);

  it("l'assegnatario lo riceve senza iscrizione; «Nuova task» non parte", async () => {
    const task = await byAutomation("p-marco");
    expect(task.assigneeId).toBe("p-marco");
    expect(alertsOf(task.code).map((n) => n.kind)).toEqual(["task.created_by_automation"]);
    const marco = (await inbox("p-marco")).filter((n) => n.objectCode === task.code);
    expect(marco).toHaveLength(1);
    expect(marco[0]!.mandatory).toEqual([{ personId: "p-marco", reason: "assignee" }]);
    // Matteo è iscritto a «Nuova task» in AUD, non a questo tipo (spento di default).
    expect((await inbox("p-matteo")).some((n) => n.objectCode === task.code)).toBe(false);
  });

  it("iscritto e assegnatario: un avviso solo, col perché dell'assegnatario", async () => {
    as("p-marco");
    await alerts.setSubscription(AUD, "task.created_by_automation", { app: true });
    const task = await byAutomation("p-marco");
    const marco = (await inbox("p-marco")).filter((n) => n.objectCode === task.code);
    expect(marco).toHaveLength(1);
    expect(marco[0]!.mandatory).toEqual([{ personId: "p-marco", reason: "assignee" }]);
    // Un iscritto che non è l'assegnatario lo riceve come iscritto.
    as("p-laura");
    await alerts.setSubscription(AUD, "task.created_by_automation", { app: true });
    const other = await byAutomation("p-marco");
    const laura = (await inbox("p-laura")).filter((n) => n.objectCode === other.code);
    expect(laura).toHaveLength(1);
    expect(laura[0]!.mandatory).toBeUndefined();
  });

  it("l'assegnatario senza tickets.view_all lo riceve; chi non vede il progetto no", async () => {
    const aud = state.projectsById.get(AUD)!;
    if (!aud.memberIds.includes("p-sara")) aud.memberIds.push("p-sara");
    grantProjectRole("p-sara", AUD, "contributor");
    const task = await byAutomation("p-sara");
    expect(task.assigneeId).toBe("p-sara");
    expect(await has("p-sara", alertsOf(task.code)[0]!.id)).toBe(true);
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-sara");
    expect(visibleProjectIds("p-sara").has(AUD)).toBe(false);
    expect(await has("p-sara", alertsOf(task.code)[0]!.id)).toBe(false);
  });

  it("nelle Preferenze: una riga sua, spenta, che dice chi lo riceve sempre", async () => {
    as("p-marco");
    const rows = (await alerts.subscriptionRows()).find((p) => p.projectId === AUD)!.rows;
    expect(rows.find((r) => r.type === "task.created_by_automation")).toMatchObject({
      group: "tasks",
      state: "off",
      mandatory: ["assignee"],
      labelKey: "alerts.types.task_created_by_automation",
    });
  });

  it("una task fatta a mano non lo pubblica", async () => {
    as("p-laura");
    const task = await createTask({ projectId: AUD, title: "A mano", assigneeId: "p-marco" });
    expect(alertsOf(task.code).map((n) => n.kind)).toEqual(["task.created"]);
  });

  it("Claude assegnatario non lo riceve (R-K5)", async () => {
    as("p-laura");
    const task = createTaskAs(
      "p-laura",
      { projectId: AUD, title: "Per Claude", assigneeId: "p-claude" },
      { source: "automation" },
    );
    const n = alertsOf(task.code);
    expect(n.map((x) => x.kind)).toEqual(["task.created_by_automation"]);
    expect(await has("p-claude", n[0]!.id)).toBe(false);
  });
});

describe("default per preset", () => {
  it("Laura riceve «Rilascio fallito» di AUD senza righe; Marco (Developer) no", async () => {
    expect(
      state.alertSubscriptions.some((s) => s.personId === "p-laura" && s.type === "release.failed"),
    ).toBe(false);
    again(failedV3, []);
    const fresh = lastId();
    expect((await inbox("p-laura")).find((n) => n.id === fresh)?.mandatory).toBeUndefined();
    expect(await has("p-marco", fresh)).toBe(false);
    as("p-marco");
    const row = (await alerts.subscriptionRows())
      .find((p) => p.projectId === AUD)!
      .rows.find((r) => r.type === "release.failed");
    expect(row).toMatchObject({ state: "off", app: false });
  });

  it("Marco riceve «Analisi con problemi» della sua PR come obbligatorio", async () => {
    const mine = (await inbox("p-marco")).find((n) => n.id === analysis.id);
    expect(mine?.mandatory).toEqual([{ personId: "p-marco", reason: "pr_author" }]);
    // Laura la riceve per default (release.merge), senza obbligo.
    const laura = (await inbox("p-laura")).find((n) => n.id === analysis.id);
    expect(laura).toBeDefined();
    expect(laura?.mandatory).toBeUndefined();
  });
});

describe("Non avvisarmi più (muteFromNotification)", () => {
  it("lascia l'avviso cliccato, spegne i futuri; Annulla ripristina", async () => {
    as("p-matteo");
    const { undo } = await alerts.muteFromNotification(prOpened.id);
    expect(await has("p-matteo", prOpened.id)).toBe(true);
    again(prOpened);
    expect(await has("p-matteo", lastId())).toBe(false);
    as("p-matteo");
    await undo();
    again(prOpened);
    expect(await has("p-matteo", lastId())).toBe(true);
    expect(state.alertSubscriptions.filter((s) => s.personId === "p-matteo")).toEqual(
      ALERT_SUBSCRIPTIONS.filter((s) => s.personId === "p-matteo"),
    );
  });

  it("R-K19: l'avviso cliccato resta anche se è nato in questa sessione", async () => {
    again(prOpened);
    const fresh = lastId();
    expect(await has("p-matteo", fresh)).toBe(true);
    as("p-matteo");
    await alerts.muteFromNotification(fresh);
    expect(await has("p-matteo", fresh)).toBe(true);
    again(prOpened);
    expect(await has("p-matteo", lastId())).toBe(false);
  });

  it("non c'è per gli obbligatori, né fuori dal catalogo", async () => {
    as("p-marco");
    await expect(alerts.muteFromNotification(analysis.id)).rejects.toThrow("forbidden");
    as("p-giulia");
    const sec = state.notifications.find(
      (n) => n.kind === "security.alert" && n.recipientIds.includes("p-giulia"),
    )!;
    await expect(alerts.muteFromNotification(sec.id)).rejects.toThrow(/^invalid: kind$/);
  });

  it("R-G5: un avviso che non si riceve risponde come uno che non esiste", async () => {
    as("p-sara");
    await expect(alerts.muteFromNotification(failedV3.id)).rejects.toThrow("not_found");
    await expect(alerts.muteFromNotification("n-nope")).rejects.toThrow("not_found");
  });

  it("un Annulla dopo resetApi non scrive", async () => {
    as("p-matteo");
    const { undo } = await alerts.muteFromNotification(prOpened.id);
    resetApi();
    setLatency(0);
    state.alertSubscriptions = [];
    await undo();
    expect(state.alertSubscriptions).toEqual([]);
  });
});

describe("kind fuori dal catalogo: invariati", () => {
  it("sicurezza, Chat, automazioni e decisioni: la regola di prima, per ognuno", async () => {
    // Un avviso di un'automazione, come lo scrive `effects.ts`.
    state.notifications.push({
      ...state.notifications.find((n) => n.kind === "security.alert")!,
      id: "n-auto-test",
      kind: "automation.notify",
      projectId: AUD,
      recipientIds: ["p-giulia"],
    });
    const kinds = new Set<string>();
    for (const person of ["p-giulia", "p-sara", "p-roberta", "p-matteo", "p-laura"]) {
      const visible = visibleProjectIds(person);
      const before = state.notifications
        .filter(
          (n) =>
            !isCatalogKind(n.kind) &&
            n.recipientIds.includes(person) &&
            (!n.projectId || visible.has(n.projectId)) &&
            (n.chatMessageId === undefined || presentChatNotification(person, n) !== null),
        )
        .map((n) => n.id);
      const now = (await inbox(person)).filter((n) => !isCatalogKind(n.kind));
      expect(now.map((n) => n.id)).toEqual(before);
      for (const n of now) kinds.add(n.chatMessageId ? "chat" : n.kind);
    }
    expect([...kinds]).toEqual(
      expect.arrayContaining(["security.alert", "chat", "automation.notify", "planning.changed"]),
    );
  });
});

describe("letto, archiviato e posticipato per persona", () => {
  it("che Laura legga non segna letto per Marco", async () => {
    const review = state.notifications.find(
      (n) => n.kind === "review.completed" && n.projectId === AUD,
    )!;
    expect((await inbox("p-laura")).find((n) => n.id === review.id)?.read).toBe(false);
    await markNotification(review.id, { read: true, snoozedUntil: "2026-11-01T09:00:00Z" });
    const laura = (await inbox("p-laura")).find((n) => n.id === review.id)!;
    expect([laura.read, laura.snoozedUntil]).toEqual([true, "2026-11-01T09:00:00Z"]);
    const marco = (await inbox("p-marco")).find((n) => n.id === review.id)!;
    expect([marco.read, marco.snoozedUntil]).toEqual([false, null]);
    expect(state.notifications.find((n) => n.id === review.id)!.read).toBe(false);
  });

  it("chi non lo riceve non lo segna", async () => {
    as("p-sara");
    await markNotification(failedV3.id, { read: true });
    expect(state.notificationMarks.size).toBe(0);
  });
});

describe("iscrizioni: righe e scritture", () => {
  it("per progetto visibile, i fissati prima; R-G5 sui progetti invisibili", async () => {
    as("p-sara");
    const rows = await alerts.subscriptionRows();
    expect(rows.some((p) => p.projectId === AUD)).toBe(false);
    const pinned = rows.filter((p) => p.pinned).map((p) => p.code);
    expect(pinned).toEqual(
      ["STW", "CBV", "TLM", "PSF", "GLT", "IDR"].filter((c) => pinned.includes(c)),
    );
    expect(rows.slice(0, pinned.length).every((p) => p.pinned)).toBe(true);
    await expect(alerts.setSubscription(AUD, "pr.opened", { app: true })).rejects.toThrow(
      "not_found",
    );
    await expect(alerts.setSubscription("prj-nope", "pr.opened", { app: true })).rejects.toThrow(
      "not_found",
    );
    await expect(alerts.muteProject(AUD)).rejects.toThrow("not_found");
  });

  it("i quattro stati: accesa, spenta, obbligatoria, sospesa", async () => {
    as("p-marco");
    const rowsOf = async () =>
      (await alerts.subscriptionRows()).find((p) => p.projectId === AUD)!.rows;
    const rows = await rowsOf();
    expect(rows.find((r) => r.type === "pr.opened")!.state).toBe("off");
    expect(rows.find((r) => r.type === "job.pr_opened")!.state).toBe("on");
    expect(rows.find((r) => r.type === "pr.corrected")!.state).toBe("mandatory");
    // I kind di prima confluiti: una riga sola.
    expect(rows.some((r) => r.type === "ticket.created")).toBe(false);
    expect(rows.find((r) => r.type === "task.created")!.state).toBe("on");
    await alerts.setSubscription(AUD, "pr.analysis_issues", { app: true });
    grantProjectRole("p-marco", AUD, "contributor");
    const suspended = (await rowsOf()).find((r) => r.type === "pr.analysis_issues")!;
    expect(suspended).toMatchObject({ state: "suspended", suspendedReason: "repos.view" });
    await expect(alerts.setSubscription(AUD, "pr.analysis_issues", { app: false })).rejects.toThrow(
      "forbidden",
    );
    // Un tipo non visibile e spento non c'è.
    expect((await rowsOf()).some((r) => r.type === "pr.corrected")).toBe(false);
  });

  it("Telefono richiede App", async () => {
    as("p-laura");
    await alerts.setSubscription(AUD, "pr.opened", { phone: true });
    const row = async () =>
      (await alerts.subscriptionRows())
        .find((p) => p.projectId === AUD)!
        .rows.find((r) => r.type === "pr.opened")!;
    expect(await row()).toMatchObject({ app: true, phone: true, state: "on" });
    await alerts.setSubscription(AUD, "pr.opened", { app: false });
    expect(await row()).toMatchObject({ app: false, phone: false, state: "off" });
    await expect(alerts.setSubscription(AUD, "pr.corrected", { app: false })).rejects.toThrow(
      "forbidden",
    );
  });

  it("la riga di kind confluiti scrive entrambi", async () => {
    as("p-laura");
    // Accesa: si scrive solo «Nuova task» (le task del cliente erano già accese per default).
    await alerts.setSubscription(AUD, "task.created", { app: true });
    const written = () =>
      state.alertSubscriptions
        .filter((s) => s.personId === "p-laura" && s.projectId === AUD)
        .map((s) => s.type)
        .sort();
    expect(written()).toEqual(["release.merged", "release.succeeded", "task.created"]);
    // Spenta: tutt'e due.
    await alerts.setSubscription(AUD, "task.created", { app: false });
    expect(written()).toEqual([
      "release.merged",
      "release.succeeded",
      "task.created",
      "ticket.created",
    ]);
    expect(await has("p-laura", seedAlert("task.created").id)).toBe(false);
  });

  it("spegni tutto: gli obbligatori arrivano comunque; Annulla", async () => {
    as("p-laura");
    const { undo } = await alerts.muteProject(AUD);
    const rows = (await alerts.subscriptionRows()).find((p) => p.projectId === AUD)!.rows;
    expect(rows.filter((r) => r.state === "on")).toEqual([]);
    expect(rows.find((r) => r.type === "pr.corrected")!.state).toBe("mandatory");
    again(failedV3, [{ personId: "p-laura", reason: "merged" }]);
    expect(await has("p-laura", lastId())).toBe(true);
    as("p-laura");
    await undo();
    expect(state.alertSubscriptions.filter((s) => s.personId === "p-laura")).toEqual(
      ALERT_SUBSCRIPTIONS.filter((s) => s.personId === "p-laura"),
    );
  });

  it("come questo progetto", async () => {
    as("p-matteo");
    const { undo } = await alerts.copySubscriptions(AUD, ACQ);
    const rows = await alerts.subscriptionRows();
    const on = (id: string) =>
      rows
        .find((p) => p.projectId === id)!
        .rows.filter((r) => r.state === "on")
        .map((r) => r.type);
    expect(on(ACQ)).toEqual(on(AUD).filter((t) => on(ACQ).includes(t)));
    expect(on(ACQ)).toContain("pr.opened");
    await undo();
    expect(state.alertSubscriptions.filter((s) => s.projectId === ACQ)).toEqual([]);
    await expect(alerts.copySubscriptions(AUD, AUD)).rejects.toThrow("invalid: same_project");
  });

  it("registerAlertTypes: la riga nuova compare nelle Preferenze", async () => {
    registerAlertTypes([
      {
        type: "test.server_struggling",
        group: "monitor",
        labelKey: "alerts.types.test_server_struggling",
        subscribe: { perm: "member" },
        defaultOn: () => true,
        defaultPhone: true,
        mandatory: [],
      },
    ]);
    as("p-laura");
    const row = (await alerts.subscriptionRows())
      .find((p) => p.projectId === AUD)!
      .rows.find((r) => r.type === "test.server_struggling");
    expect(row).toMatchObject({ group: "monitor", state: "on", app: true, phone: true });
    // resetApi rimette il catalogo: la riga di prova non passa ai test dopo.
    const before = ALERT_TYPES.length;
    resetApi();
    setLatency(0);
    expect(isCatalogKind("test.server_struggling")).toBe(false);
    expect(ALERT_TYPES).toHaveLength(before - 1);
    as("p-laura");
    const rows = (await alerts.subscriptionRows()).find((p) => p.projectId === AUD)!.rows;
    expect(rows.some((r) => r.type === "test.server_struggling")).toBe(false);
  });

  it("publishAlert rifiuta un kind fuori dal catalogo con un codice", () => {
    expect(() => again({ ...prOpened, kind: "security.alert" })).toThrow(/^invalid: kind$/);
  });

  it("failNext e resetApi", async () => {
    as("p-laura");
    failNext("alerts.setSubscription");
    await expect(alerts.setSubscription(AUD, "pr.opened", { app: true })).rejects.toThrow();
    expect(state.alertSubscriptions).toEqual(ALERT_SUBSCRIPTIONS);
    await alerts.setSubscription(AUD, "pr.opened", { app: true });
    await markNotification(failedV3.id, { read: true });
    again(prOpened);
    resetApi();
    expect(state.alertSubscriptions).toEqual(ALERT_SUBSCRIPTIONS);
    expect(state.notificationMarks.size).toBe(0);
    expect(state.notifications.some((n) => n.id.startsWith("n-alert"))).toBe(false);
  });
});
