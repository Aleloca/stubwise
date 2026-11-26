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
  pushPreference: () => true,
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

  it("46: senza una riga, il Telefono di partenza vuole ANCHE l'interruttore push di oggi; con una riga vale la riga", () => {
    const pushOff = (u: string) => u !== "b";
    expect(catalogRecipients(t("release.failed"), ctx({ pushPreference: pushOff })).phone).toEqual(new Set(["a"]));
    const subscriptions = new Map([["b", { app: true, phone: true }]]);
    expect(catalogRecipients(t("release.failed"), ctx({ pushPreference: pushOff, subscriptions })).phone.has("b")).toBe(true);
    // Anche da obbligatorio senza riga.
    expect(catalogRecipients(t("release.failed"), ctx({ pushPreference: () => false, mandatory: [{ userId: "d", reason: "merged" }] })).phone.has("d")).toBe(false);
  });
});

describe("area 10, F5: member.added (D-11 = b)", () => {
  // b ha project.members.manage (un gestore), c no; e è la persona aggiunta.
  const MEM: Record<string, string[]> = { b: ["project.members.manage"], c: [] };
  const mctx = (over: Partial<CatalogRecipientsContext> = {}) =>
    ctx({ members: ["a", "b", "c", "e"], holds: (u, p) => u === "a" || (MEM[u] ?? []).includes(p), mandatory: [{ userId: "e", reason: "added" }], ...over });

  it("alla persona aggiunta (obbligatoria) e a chi gestisce i membri (di partenza); a un membro qualunque no; il telefono spento di partenza", () => {
    const out = catalogRecipients(t("member.added"), mctx());
    expect([...out.app].sort()).toEqual(["a", "b", "e"]);
    expect(out.mandatory.get("e")).toBe("added");
    expect(out.phone.size).toBe(0);
  });

  it("MAI a chi ha agito, né come iscritto né come obbligatorio (aggiungere sé stessi non avvisa sé stessi)", () => {
    expect(catalogRecipients(t("member.added"), mctx({ exclude: ["b"] })).app.sort()).toEqual(["a", "e"]);
    const self = catalogRecipients(t("member.added"), mctx({ mandatory: [{ userId: "b", reason: "added" }], exclude: ["b"] }));
    expect(self.app).not.toContain("b");
    expect(self.mandatory.has("b")).toBe(false);
  });

  it("un gestore che lo spegne non lo riceve; la persona aggiunta sì, anche con la riga spenta", () => {
    const subscriptions = new Map([["b", { app: false, phone: false }], ["e", { app: false, phone: false }]]);
    const out = catalogRecipients(t("member.added"), mctx({ subscriptions }));
    expect(out.app).not.toContain("b");
    expect(out.app).toContain("e");
  });
});

describe("area 11, F2: la doc di prodotto (N-1 = a)", () => {
  // w scrive la doc (docs.edit + docs.view), r la legge (docs.view), x è un membro che non legge i Docs.
  const DOCS: Record<string, string[]> = { w: ["docs.view", "docs.edit"], r: ["docs.view"], x: [] };
  const dctx = (over: Partial<CatalogRecipientsContext> = {}) =>
    ctx({ members: ["w", "r", "x"], fullAdmins: new Set(), holds: (u, p) => (DOCS[u] ?? []).includes(p), ...over });

  it("la menzione va SOLO al menzionato, col Telefono acceso di partenza; nessun iscritto", () => {
    const out = catalogRecipients(t("product_doc.mention"), dctx({ mandatory: [{ userId: "r", reason: "mentioned" }] }));
    expect(out.app).toEqual(["r"]);
    expect(out.phone.has("r")).toBe(true);
    expect(out.mandatory.get("r")).toBe("mentioned");
  });

  it("la menzione arriva anche con la riga scritta spenta (non ha un interruttore)", () => {
    const subscriptions = new Map([["r", { app: false, phone: true }]]);
    expect(catalogRecipients(t("product_doc.mention"), dctx({ subscriptions, mandatory: [{ userId: "r", reason: "mentioned" }] })).app).toEqual(["r"]);
  });

  it("la visibilità prima di tutto: una menzione a chi non legge i Docs del progetto NON arriva, né a chi non è più membro", () => {
    const out = catalogRecipients(t("product_doc.mention"), dctx({ mandatory: [{ userId: "x", reason: "mentioned" }, { userId: "gone", reason: "mentioned" }] }));
    expect(out.app).toEqual([]);
    expect(out.mandatory.size).toBe(0);
  });

  it("aggiornamento e domanda: di partenza a chi scrive la doc; chi la legge solo se la accende; chi non legge i Docs mai", () => {
    for (const kind of ["product_doc.updated", "product_doc.question"]) {
      expect(catalogRecipients(t(kind), dctx()).app, kind).toEqual(["w"]);
      const subscriptions = new Map([["r", { app: true, phone: false }], ["x", { app: true, phone: false }]]);
      expect(catalogRecipients(t(kind), dctx({ subscriptions })).app.sort(), kind).toEqual(["r", "w"]);
    }
  });

  it("chi SEGUE la pagina riceve aggiornamento e domanda anche con la riga spenta (motivo `follower`)", () => {
    const subscriptions = new Map([["w", { app: false, phone: false }], ["r", { app: false, phone: false }]]);
    for (const kind of ["product_doc.updated", "product_doc.question"]) {
      const out = catalogRecipients(t(kind), dctx({ subscriptions, mandatory: [{ userId: "r", reason: "follower" }] }));
      expect(out.app, kind).toEqual(["r"]);
      expect(out.mandatory.get("r"), kind).toBe("follower");
    }
  });

  it("un seguace che non legge più i Docs non riceve niente", () => {
    expect(catalogRecipients(t("product_doc.updated"), dctx({ mandatory: [{ userId: "x", reason: "follower" }] })).app).toEqual(["w"]);
  });
});
