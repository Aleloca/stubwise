import { describe, expect, it } from "vitest";
import { notificationKindSchema } from "../schemas/notification.js";
import {
  ALERT_TYPES,
  LIVE_ALERT_TYPES,
  alertTypeOf,
  defaultApplies,
  isLiveAlertType,
  liveRowTypes,
  rowPartners,
  rowTypeOf,
} from "./catalog.js";

// Area 8, F2 (R-5 = a): il catalogo dei tipi di avviso in UN posto, per il
// prototipo, il server e il worker (era `domain/alerts/catalog.ts` e
// `data/servers/alertTypes.ts` del prototipo).

const KINDS = new Set<string>(notificationKindSchema.options);

describe("la parità col server", () => {
  it("ogni tipo vivo è un notification_kind", () => {
    for (const t of LIVE_ALERT_TYPES) expect(KINDS.has(t), t).toBe(true);
  });

  it("ogni tipo vivo è nel catalogo, e ogni sameRowAs punta a un tipo del catalogo", () => {
    for (const t of LIVE_ALERT_TYPES) expect(alertTypeOf(t), t).toBeDefined();
    for (const t of ALERT_TYPES)
      if (t.sameRowAs) expect(alertTypeOf(t.sameRowAs), t.type).toBeDefined();
  });

  it("nessun tipo vivo è fra quelli a destinatari fissi (S-4)", () => {
    for (const fixed of [
      "security.alert",
      "decision.requested",
      "chat.mention",
      "automation.approval",
    ])
      expect(isLiveAlertType(fixed)).toBe(false);
  });
});

describe("il default come dato", () => {
  const holds = (perms: string[]) => (p: string) => perms.includes(p);

  it("off, tutti i membri, o chi ha un permesso nel progetto", () => {
    expect(defaultApplies("off", holds(["release.merge"]))).toBe(false);
    expect(defaultApplies("members", holds([]))).toBe(true);
    expect(defaultApplies({ perm: "release.merge" }, holds(["release.merge"]))).toBe(true);
    expect(defaultApplies({ perm: "release.merge" }, holds([]))).toBe(false);
  });

  it("release.failed parte acceso per chi può rilasciare, con gli obbligatori del merge", () => {
    const t = alertTypeOf("release.failed")!;
    expect(t.defaultOn).toEqual({ perm: "release.merge" });
    expect(t.mandatory).toEqual(["merged", "task_author"]);
  });

  it("M-1 = a: nella build app i monitor.* partono per chi ha monitor.manage; nel prototipo per tutti i membri", () => {
    const t = alertTypeOf("monitor.alert")!;
    expect(t.defaultOn).toBe("members");
    expect(t.appDefaultOn).toEqual({ perm: "monitor.manage" });
  });

  it("pr.corrected si riceve solo da obbligatorio", () => {
    expect(alertTypeOf("pr.corrected")).toMatchObject({
      mandatoryOnly: true,
      mandatory: ["pr_author"],
    });
  });
});

describe("area 11, F2: la doc di prodotto (N-1 = a)", () => {
  it("tre righe nella famiglia Docs, tutte con un notification_kind, solo per chi legge i Docs", () => {
    for (const kind of ["product_doc.mention", "product_doc.updated", "product_doc.question"]) {
      const t = alertTypeOf(kind)!;
      expect(t.group, kind).toBe("docs");
      expect(t.seePerm, kind).toBe("docs.view");
      expect(KINDS.has(kind), kind).toBe(true);
    }
  });

  it("la menzione è SOLO obbligatoria (motivo `mentioned`), col Telefono acceso", () => {
    expect(alertTypeOf("product_doc.mention")).toMatchObject({ mandatoryOnly: true, mandatory: ["mentioned"], defaultPhone: true });
  });

  it("aggiornamento e domanda: ci si iscrive con docs.view, accesi di partenza per docs.edit, `follower` obbligatorio, Telefono spento", () => {
    for (const kind of ["product_doc.updated", "product_doc.question"]) {
      const t = alertTypeOf(kind)!;
      expect(t, kind).toMatchObject({ subscribe: { perm: "docs.view" }, defaultOn: { perm: "docs.edit" }, mandatory: ["follower"], defaultPhone: false });
      expect(t.mandatoryOnly, kind).toBeUndefined();
    }
  });

  it("aggiornamento e domanda non sono vivi in F2 (i produttori arrivano con F5)", () => {
    expect(isLiveAlertType("product_doc.updated")).toBe(false);
    expect(isLiveAlertType("product_doc.question")).toBe(false);
  });
});

describe("le righe delle Preferenze", () => {
  it("i kind di prima confluiti stanno nella riga del tipo nuovo, che li scrive insieme", () => {
    expect(rowTypeOf("monitor.alert")).toBe("server.trouble");
    expect(rowPartners("server.trouble").map((t) => t.type)).toEqual(
      expect.arrayContaining([
        "server.trouble",
        "server.down",
        "monitor.alert",
        "monitor.recovered",
      ]),
    );
  });

  it("i tipi di una riga partono col Telefono della riga (decisione del maintainer, 14 nov 2026: anche i «rientrato»)", () => {
    for (const t of ALERT_TYPES.filter((x) => x.sameRowAs)) {
      expect(t.defaultPhone, t.type).toBe(alertTypeOf(t.sameRowAs!)!.defaultPhone);
    }
    expect(alertTypeOf("monitor.recovered")!.defaultPhone).toBe(true);
    expect(alertTypeOf("server.recovered")!.defaultPhone).toBe(true);
  });

  it("una riga si mostra se uno dei suoi tipi è vivo (la riga dei monitor.* con server.trouble non ancora vivo)", () => {
    expect(isLiveAlertType("server.trouble")).toBe(false);
    expect(liveRowTypes()).toContain("server.trouble");
    expect(liveRowTypes()).toContain("release.failed");
    // Un tipo del catalogo senza produttore non ha la sua riga (area 8, F3: i support.* sono vivi).
    expect(liveRowTypes()).not.toContain("task.created");
    expect(liveRowTypes()).toContain("support.request");
  });
});
