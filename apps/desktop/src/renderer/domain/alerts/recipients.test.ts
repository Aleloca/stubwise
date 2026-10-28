import { describe, expect, it } from "vitest";
import type { AlertSubscription, AppNotification } from "../../data/model";
import type { Permission } from "../../data/viewer";
import {
  alertTypeOf,
  ALERT_TYPES,
  isCatalogKind,
  registerAlertTypes,
  rowPartners,
  type AlertType,
} from "./catalog";
import { mergeMandatory, recipientsOf, subscriptionAt } from "./recipients";

const notification = (over: Partial<AppNotification>): AppNotification => ({
  id: "n-x",
  kind: "release.failed",
  projectId: "prj-aud",
  objectCode: "AUD-V9",
  departmentId: null,
  recipientIds: [],
  title: "",
  body: "",
  createdAt: "2026-10-20T10:00:00Z",
  read: false,
  archived: false,
  snoozedUntil: null,
  link: "",
  ...over,
});

const perms =
  (...held: Permission[]) =>
  (p: Permission) =>
    held.includes(p);

const sub = (
  personId: string,
  type: string,
  history: AlertSubscription["history"],
): AlertSubscription => ({ personId, projectId: "prj-aud", type, history });

describe("catalogo degli avvisi", () => {
  it("ha i tipi dell'8a e quelli già esistenti; sicurezza e decisioni fuori", () => {
    for (const kind of [
      "pr.opened",
      "pr.analysis_issues",
      "pr.corrected",
      "release.merged",
      "release.succeeded",
      "release.failed",
      "docs.release_note",
      "task.created",
      "support.request",
      "support.customer_replied",
      "job.pr_opened",
      "review.completed",
      "job.failed",
      "project.brief",
      "docs.nightly_attention",
      "monitor.alert",
      "monitor.recovered",
      "ticket.created",
      "request.created",
    ])
      expect(isCatalogKind(kind), kind).toBe(true);
    for (const kind of [
      "security.alert",
      "job.plan_review",
      "job.awaiting_input",
      "project.pulse",
      "google.proposal",
      "google.proposal_handed",
      "chat.mention",
      "automation.notify",
      "planning.changed",
    ])
      expect(isCatalogKind(kind), kind).toBe(false);
  });

  it("i default dello spec: permesso, valore di partenza, obbligatori", () => {
    const merge = perms("release.merge");
    const none = perms();
    expect(alertTypeOf("pr.opened")!.defaultOn(merge)).toBe(false);
    expect(alertTypeOf("pr.analysis_issues")!.subscribe.perm).toBe("repos.view");
    expect(alertTypeOf("pr.analysis_issues")!.defaultOn(merge)).toBe(true);
    expect(alertTypeOf("pr.analysis_issues")!.defaultOn(none)).toBe(false);
    expect(alertTypeOf("pr.analysis_issues")!.mandatory).toEqual(["pr_author"]);
    expect(alertTypeOf("pr.corrected")!.mandatoryOnly).toBe(true);
    expect(alertTypeOf("release.failed")!.mandatory).toEqual(["merged", "task_author"]);
    expect(alertTypeOf("release.failed")!.defaultOn(merge)).toBe(true);
    expect(alertTypeOf("support.request")!.defaultOn(perms("backlog.edit"))).toBe(true);
    expect(alertTypeOf("support.customer_replied")!.mandatory).toEqual(["follows_conversation"]);
    // I kind di prima: la regola di oggi, tutti i membri.
    expect(alertTypeOf("job.pr_opened")!.subscribe.perm).toBe("member");
    expect(alertTypeOf("job.pr_opened")!.defaultOn(none)).toBe(true);
  });

  it("i kind con lo stesso significato sono una riga sola (shape [A 10])", () => {
    expect(alertTypeOf("ticket.created")!.sameRowAs).toBe("task.created");
    expect(alertTypeOf("request.created")!.sameRowAs).toBe("support.request");
    expect(rowPartners("task.created").map((t) => t.type)).toEqual([
      "task.created",
      "ticket.created",
    ]);
  });

  it("registerAlertTypes aggiunge righe (8b) e sostituisce quelle con lo stesso tipo", () => {
    const row: AlertType = {
      type: "test.server_down",
      group: "monitor",
      labelKey: "alerts.types.test_server_down",
      subscribe: { perm: "member" },
      defaultOn: () => true,
      defaultPhone: true,
      mandatory: [],
    };
    const before = ALERT_TYPES.length;
    registerAlertTypes([row]);
    registerAlertTypes([{ ...row, defaultPhone: false }]);
    expect(ALERT_TYPES).toHaveLength(before + 1);
    expect(isCatalogKind("test.server_down")).toBe(true);
    expect(alertTypeOf("test.server_down")!.defaultPhone).toBe(false);
  });
});

describe("subscriptionAt", () => {
  const def = alertTypeOf("release.failed")!;
  const history = [
    { at: "2026-10-01T09:00:00Z", app: true, phone: false },
    { at: "2026-10-21T09:00:00Z", app: false, phone: false },
  ];
  const s = sub("p-giulia", "release.failed", history);

  it("conta lo stato al momento dell'avviso", () => {
    expect(subscriptionAt(s, def, perms(), "2026-10-20T00:00:00Z")).toEqual({
      app: true,
      phone: false,
    });
    expect(subscriptionAt(s, def, perms(), "2026-10-22T00:00:00Z").app).toBe(false);
  });

  it("prima della prima voce, e senza riga, vale il default (di un membro)", () => {
    expect(subscriptionAt(s, def, perms("release.merge"), "2026-09-01T00:00:00Z")).toEqual({
      app: true,
      phone: true,
    });
    expect(subscriptionAt(undefined, def, perms(), "2026-09-01T00:00:00Z").app).toBe(false);
    // Chi non è membro (un full admin che vede il progetto) parte spento.
    expect(subscriptionAt(undefined, def, perms("release.merge"), "x", false).app).toBe(false);
  });
});

describe("recipientsOf", () => {
  const base = {
    members: ["p-laura", "p-marco", "p-giulia"],
    subs: [] as AlertSubscription[],
    permsOf: (id: string) => (id === "p-laura" ? perms("release.merge") : perms()),
    seesProject: () => true,
  };

  it("obbligatori, iscritti e default; l'obbligatorio vince sul perché", () => {
    const n = notification({ mandatory: [{ personId: "p-marco", reason: "merged" }] });
    expect(recipientsOf(n, base)).toEqual([
      { personId: "p-laura", why: "subscribed" },
      { personId: "p-marco", why: "merged" },
    ]);
  });

  it("un obbligatorio arriva anche con l'iscrizione spenta, ma non senza il progetto", () => {
    const n = notification({ mandatory: [{ personId: "p-laura", reason: "merged" }] });
    const off = sub("p-laura", "release.failed", [
      { at: "2026-10-01T00:00:00Z", app: false, phone: false },
    ]);
    expect(recipientsOf(n, { ...base, subs: [off] })).toEqual([
      { personId: "p-laura", why: "merged" },
    ]);
    expect(recipientsOf(n, { ...base, seesProject: (id) => id !== "p-laura" })).toEqual([]);
  });

  it("i permessi contano adesso, anche per gli obbligatori", () => {
    const n = notification({
      kind: "pr.analysis_issues",
      mandatory: [{ personId: "p-marco", reason: "pr_author" }],
    });
    expect(recipientsOf(n, { ...base, permsOf: () => perms("repos.view") })).toEqual([
      { personId: "p-marco", why: "pr_author" },
    ]);
    expect(recipientsOf(n, { ...base, permsOf: () => perms() })).toEqual([]);
  });

  it("un iscritto che non è fra i membri (full admin) riceve; senza riga no", () => {
    const n = notification({ kind: "pr.opened" });
    const roberta = sub("p-roberta", "pr.opened", [
      { at: "2026-10-01T00:00:00Z", app: true, phone: false },
    ]);
    expect(recipientsOf(n, { ...base, subs: [roberta] })).toEqual([
      { personId: "p-roberta", why: "subscribed" },
    ]);
    expect(recipientsOf(n, base)).toEqual([]);
  });

  it("un tipo solo obbligatorio non passa dalle iscrizioni", () => {
    const n = notification({ kind: "pr.corrected" });
    const on = sub("p-laura", "pr.corrected", [
      { at: "2026-10-01T00:00:00Z", app: true, phone: false },
    ]);
    expect(recipientsOf(n, { ...base, subs: [on], permsOf: () => perms("repos.view") })).toEqual(
      [],
    );
  });
});

describe("mergeMandatory", () => {
  it("chi ha fatto il merge; fuori da Stubwise l'autore della task, o nessuno", () => {
    expect(mergeMandatory("p-laura", "p-elena")).toEqual([
      { personId: "p-laura", reason: "merged" },
    ]);
    expect(mergeMandatory(null, "p-elena")).toEqual([
      { personId: "p-elena", reason: "task_author" },
    ]);
    expect(mergeMandatory(null, null)).toEqual([]);
  });
});
