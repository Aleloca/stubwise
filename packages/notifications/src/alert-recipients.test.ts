import { alertTypeOf, type AlertType } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { catalogRecipients, type CatalogRecipientsContext } from "./alert-recipients.js";

const t = (kind: string): AlertType => alertTypeOf(kind)!;
// a: full admin; b: Project Lead (release.merge, monitor.manage, repos.view); c: Developer (repos.view); d: Viewer.
const PERMS: Record<string, string[]> = { b: ["release.merge", "monitor.manage", "repos.view"], c: ["repos.view"], d: [] };
const ctx = (over: Partial<CatalogRecipientsContext> = {}): CatalogRecipientsContext => ({
  members: ["a", "b", "c", "d"],
  fullAdmins: new Set(["a"]),
  holds: (u, p) => u === "a" || (PERMS[u] ?? []).includes(p),
  subscriptions: new Map(),
  mandatory: [],
  ...over,
});

describe("catalogRecipients (area 8, F2, S2)", () => {
  it("senza iscrizioni: il default del catalogo dai permessi di adesso (release.failed → chi ha release.merge)", () => {
    expect(catalogRecipients(t("release.failed"), ctx())).toEqual({ app: ["a", "b"], phone: new Set(["a", "b"]), mandatory: new Map() });
  });

  it("M-1 = a: i monitor.* di partenza a chi ha monitor.manage, non a ogni membro", () => {
    expect(catalogRecipients(t("monitor.alert"), ctx()).app).toEqual(["a", "b"]);
  });

  it("un'iscrizione scritta vince sul default, nei due versi", () => {
    const subscriptions = new Map([["b", { app: false, phone: false }], ["d", { app: true, phone: false }]]);
    expect(catalogRecipients(t("release.failed"), ctx({ subscriptions })).app).toEqual(["a", "d"]);
  });

  it("un obbligatorio arriva anche con l'iscrizione spenta; il telefono segue la sua riga", () => {
    const subscriptions = new Map([["d", { app: false, phone: false }]]);
    const out = catalogRecipients(t("release.failed"), ctx({ subscriptions, mandatory: [{ userId: "d", reason: "merged" }] }));
    expect(out.app).toContain("d");
    expect(out.phone.has("d")).toBe(false);
    expect(out.mandatory.get("d")).toBe("merged");
  });

  it("un motivo che il tipo non prevede non rende obbligatorio", () => {
    expect(catalogRecipients(t("release.merged"), ctx({ mandatory: [{ userId: "d", reason: "merged" }] })).app).toEqual([]);
  });

  it("mandatoryOnly: SOLO gli obbligatori, nessuna iscrizione conta", () => {
    const subscriptions = new Map([["c", { app: true, phone: true }]]);
    expect(catalogRecipients(t("pr.corrected"), ctx({ subscriptions, mandatory: [{ userId: "d", reason: "pr_author" }] })).app).toEqual(["d"]);
  });

  it("chi non può iscriversi (subscribe.perm) non la riceve neanche con una riga accesa", () => {
    const subscriptions = new Map([["d", { app: true, phone: true }]]);
    expect(catalogRecipients(t("pr.analysis_issues"), ctx({ subscriptions })).app).not.toContain("d");
  });

  it("chi non vede il progetto non la riceve mai, nemmeno da obbligatorio", () => {
    expect(catalogRecipients(t("release.failed"), ctx({ members: ["b"], mandatory: [{ userId: "x", reason: "merged" }] })).app).toEqual(["b"]);
  });

  it("il Telefono di partenza è `defaultPhone` (release.merged: spento anche se ci si iscrive con App)", () => {
    const subscriptions = new Map([["c", { app: true, phone: false }]]);
    expect(catalogRecipients(t("release.merged"), ctx({ subscriptions }))).toEqual({ app: ["c"], phone: new Set(), mandatory: new Map() });
  });
});
