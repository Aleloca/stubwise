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
    expect(liveRowTypes()).not.toContain("support.request");
  });
});
