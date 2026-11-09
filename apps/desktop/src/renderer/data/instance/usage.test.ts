import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, instance, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission, type LocalInstancePermission } from "../viewer";
import type { UsageRecord } from "./state";
import { recordUsage, spentThisMonthUsd } from "./usage";

// I consumi d'istanza (area 9b, Task 2). `now()` è fermo al 23 ott 2026: i
// test costruiscono un seme piccolo e contano a mano. Persone: Roberta (full
// admin), Sara (User, vede STW ma non AUD né MKX), Marco (User).

const ROBERTA = "p-roberta";
const SARA = "p-sara";
const MARCO = "p-marco";

const as = (personId: string) => setSessionPersonId(personId);

let n = 0;
const rec = (over: Partial<UsageRecord> & Pick<UsageRecord, "at" | "costUsd">): UsageRecord => ({
  id: `u-${++n}`,
  operation: "fix_execute",
  model: "claude-sonnet-4-5",
  projectId: "prj-stw",
  providerId: "prv-team-max",
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 5000,
  conversationId: null,
  ...over,
});

/** 7gg: dal 17 ott; 30gg: dal 24 set; 90gg: dal 26 lug; il mese: dall'1 ott. */
const SMALL: UsageRecord[] = [
  rec({ at: "2026-10-23T09:00:00Z", costUsd: 1.5 }),
  rec({
    at: "2026-10-20T09:00:00Z",
    costUsd: 2.25,
    projectId: "prj-aud",
    operation: "fix_plan",
    model: "claude-opus-4-5",
    providerId: "prv-billing-key",
  }),
  rec({
    at: "2026-10-10T09:00:00Z",
    costUsd: 0.5,
    operation: "chat",
    model: "claude-haiku-4-5",
  }),
  rec({ at: "2026-09-30T09:00:00Z", costUsd: 0.25, projectId: "prj-mkx" }),
  rec({ at: "2026-10-17T09:00:00Z", costUsd: 0.125, projectId: null, operation: "mail_classify" }),
  rec({ at: "2026-09-20T09:00:00Z", costUsd: 4, projectId: "prj-aud" }),
  rec({ at: "2026-08-10T09:00:00Z", costUsd: 8 }),
  rec({ at: "2026-07-01T09:00:00Z", costUsd: 16 }),
];

beforeEach(() => {
  setLatency(0);
  resetApi();
  state.instance.usage = SMALL.map((r) => ({ ...r }));
  as(ROBERTA);
});
afterEach(() => resetApi());

const totalOf = async (range: Parameters<typeof instance.getUsage>[0]["range"]) =>
  (await instance.getUsage({ range, groupBy: "day" })).totals;

describe("i totali per intervallo", () => {
  it("7, 30, 90 giorni e il mese, somme esatte", async () => {
    expect((await totalOf({ days: 7 })).costUsd).toBe(3.875);
    expect((await totalOf({ days: 30 })).costUsd).toBe(4.625);
    expect((await totalOf({ days: 90 })).costUsd).toBe(16.625);
    expect((await totalOf({ month: true })).costUsd).toBe(4.375);
  });

  it("token e corse sono sommati negli stessi intervalli", async () => {
    const t = await totalOf({ days: 7 });
    expect(t).toEqual({
      costUsd: 3.875,
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 15000,
      runs: 3,
    });
  });

  it("un intervallo libero è inclusivo dei due estremi", async () => {
    const t = await totalOf({ from: "2026-10-10", to: "2026-10-17" });
    expect(t.costUsd).toBe(0.625);
    expect(t.runs).toBe(2);
  });

  it("byDay ha un punto per ogni giorno dell'intervallo, anche a zero", async () => {
    const v = await instance.getUsage({ range: { days: 7 }, groupBy: "day" });
    expect(v.byDay.map((d) => d.day)).toEqual([
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(v.byDay.map((d) => d.costUsd)).toEqual([0.125, 0, 0, 2.25, 0, 0, 1.5]);
    // Le corse del giorno: il passaggio sulla colonna e la tabella le dicono (Task 9).
    expect(v.byDay.map((d) => d.runs)).toEqual([1, 0, 0, 1, 0, 0, 1]);
  });
});

describe("le righe", () => {
  it("per modello: nome leggibile, ordine per costo", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "model" });
    expect(v.rows.map((r) => [r.key, r.label, r.costUsd])).toEqual([
      ["claude-sonnet-4-5", "Sonnet 4.5", 13.875],
      ["claude-opus-4-5", "Opus 4.5", 2.25],
      ["claude-haiku-4-5", "Haiku 4.5", 0.5],
    ]);
  });

  it("per progetto la riga porta il codice; senza progetto no (Task 9)", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "project" });
    expect(v.rows.find((r) => r.key === "prj-stw")!.code).toBe("STW");
    expect(v.rows.find((r) => r.key === null)!.code).toBeUndefined();
    const byModel = await instance.getUsage({ range: { days: 90 }, groupBy: "model" });
    expect(byModel.rows.every((r) => r.code === undefined)).toBe(true);
  });

  it("per provider usa il nome del provider", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "provider" });
    expect(v.rows.map((r) => r.label)).toEqual(["Team Max", "Billing key"]);
  });

  it("per operazione il label è il nome dell'operazione (le parole sono della UI)", async () => {
    const v = await instance.getUsage({ range: { days: 7 }, groupBy: "operation" });
    expect(v.rows.map((r) => r.key).sort()).toEqual(["fix_execute", "fix_plan", "mail_classify"]);
    expect(v.rows.every((r) => r.label === r.key)).toBe(true);
  });

  it("senza thenBy i figli sono vuoti", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "model" });
    expect(v.rows.every((r) => r.children.length === 0)).toBe(true);
  });

  it("thenBy dà i figli, e la loro somma è la riga", async () => {
    const v = await instance.getUsage({
      range: { days: 90 },
      groupBy: "model",
      thenBy: "operation",
    });
    for (const row of v.rows) {
      expect(row.children.length).toBeGreaterThan(0);
      const sum = row.children.reduce((a, c) => a + c.costUsd, 0);
      expect(Math.round(sum * 1e6) / 1e6).toBe(row.costUsd);
      expect(row.children.reduce((a, c) => a + c.runs, 0)).toBe(row.runs);
      expect(row.children.reduce((a, c) => a + c.tokens, 0)).toBe(row.tokens);
    }
  });
});

describe("R-G5: i progetti che chi guarda non vede", () => {
  beforeEach(() => {
    grantInstancePermission(SARA, "usage.view" as LocalInstancePermission);
    as(SARA);
  });

  it("per progetto: solo i suoi, più «Other projects»", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "project" });
    const keys = v.rows.map((r) => r.key);
    expect(keys).toContain("prj-stw");
    expect(keys).toContain("other");
    expect(keys).not.toContain("prj-aud");
    expect(keys).not.toContain("prj-mkx");
    const other = v.rows.find((r) => r.key === "other")!;
    expect(other.label).toBe("Other projects");
    expect(other.code).toBeUndefined();
    expect(other.costUsd).toBe(6.5);
    expect(v.rows.find((r) => r.key === "prj-stw")!.costUsd).toBe(10);
    // Il costo senza progetto resta una riga a sé, con chiave nulla.
    expect(v.rows.find((r) => r.key === null)!.costUsd).toBe(0.125);
    // L'ordine: «Other projects» chiude l'elenco.
    expect(v.rows.at(-1)!.key).toBe("other");
  });

  it("nessun codice, id o nome d'altri nella risposta serializzata (RF 2), con qualunque dimensione", async () => {
    for (const groupBy of ["day", "model", "project", "provider", "operation"] as const) {
      for (const thenBy of [undefined, "project", "model"] as const) {
        const v = await instance.getUsage({ range: { days: 90 }, groupBy, thenBy });
        const text = JSON.stringify(v);
        for (const secret of ["prj-aud", "prj-mkx", "Audin", "Campagne primavera", "AUD", "MKX"])
          expect(text, `${groupBy}/${thenBy}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("con groupBy diverso da project i totali contano tutto, senza rivelare niente", async () => {
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "model" });
    expect(v.totals.costUsd).toBe(16.625);
    expect(v.rows.reduce((a, r) => a + r.costUsd, 0)).toBeCloseTo(16.625, 6);
  });

  it("thenBy project: i figli fanno la stessa regola", async () => {
    const v = await instance.getUsage({
      range: { days: 90 },
      groupBy: "model",
      thenBy: "project",
    });
    const opus = v.rows.find((r) => r.key === "claude-opus-4-5")!;
    expect(opus.children.map((c) => c.key)).toEqual(["other"]);
  });

  it("un full admin vede i progetti col loro nome", async () => {
    as(ROBERTA);
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "project" });
    expect(v.rows.map((r) => r.key)).toContain("prj-aud");
    expect(v.rows.map((r) => r.key)).not.toContain("other");
    expect(v.rows.find((r) => r.key === "prj-aud")!.label).toBe("Audin 2.0");
  });
});

describe("permesso, errori, scritture", () => {
  it("senza usage.view → forbidden", async () => {
    as(MARCO);
    await expect(instance.getUsage({ range: { days: 7 }, groupBy: "day" })).rejects.toThrow(
      "forbidden",
    );
  });

  it("failNext fa fallire la chiamata successiva, una volta sola", async () => {
    failNext("instance.getUsage");
    await expect(instance.getUsage({ range: { days: 7 }, groupBy: "day" })).rejects.toThrow(
      "Simulated failure",
    );
    await expect(instance.getUsage({ range: { days: 7 }, groupBy: "day" })).resolves.toBeDefined();
  });

  it("spentThisMonthUsd conta tutti i progetti, anche se chi guarda non li vede", () => {
    expect(spentThisMonthUsd()).toBe(4.375);
  });

  it("recordUsage aggiunge una riga con un id nuovo, e i totali la contano", async () => {
    recordUsage({
      at: "2026-10-23T11:00:00Z",
      operation: "chat",
      model: "claude-haiku-4-5",
      projectId: "prj-stw",
      providerId: "prv-team-max",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      costUsd: 0.5,
      conversationId: null,
    });
    expect(state.instance.usage).toHaveLength(SMALL.length + 1);
    expect(new Set(state.instance.usage.map((u) => u.id)).size).toBe(SMALL.length + 1);
    expect(spentThisMonthUsd()).toBe(4.875);
    expect((await totalOf({ days: 7 })).runs).toBe(4);
  });
});

describe("il seme", () => {
  beforeEach(() => {
    resetApi();
    as(ROBERTA);
  });

  it("copre 90 giorni e il mese in corso sta sotto il budget (circa 410 su 600)", async () => {
    const spent = spentThisMonthUsd();
    expect(spent).toBeGreaterThan(395);
    expect(spent).toBeLessThan(425);
    expect(state.instance.budget.monthlyUsd).toBe(600);
    const v = await instance.getUsage({ range: { days: 90 }, groupBy: "day" });
    expect(v.byDay).toHaveLength(90);
    expect(v.byDay.filter((d) => d.costUsd > 0).length).toBeGreaterThan(80);
  });

  it("ha una voce per ogni sessione di lavoro del seme, con le sue cifre", () => {
    const runs = state.conversations.filter((c) => c.usage && c.usage.length > 0);
    expect(runs.length).toBeGreaterThan(5);
    for (const c of runs) {
      const mine = state.instance.usage.filter((u) => u.conversationId === c.id);
      expect(mine.length, c.id).toBe(c.usage!.length);
      expect(mine.reduce((a, u) => a + u.costUsd, 0)).toBeCloseTo(
        c.usage!.reduce((a, u) => a + u.costUsd, 0),
        6,
      );
      expect(mine.every((u) => u.providerId !== "" && u.projectId === c.projectId)).toBe(true);
    }
  });

  it("ha voci per le operazioni notturne, i report, la posta e la chat; è deterministico", () => {
    const ops = new Set(state.instance.usage.map((u) => u.operation));
    for (const op of ["commit_summary", "docs_nightly", "daily_report", "mail_classify", "chat"])
      expect(ops.has(op as never), op).toBe(true);
    const first = JSON.stringify(state.instance.usage);
    resetApi();
    expect(JSON.stringify(state.instance.usage)).toBe(first);
  });

  it("ogni voce nomina un provider del seme e nessuna cade nel futuro", () => {
    const providers = new Set(state.instance.providers.map((p) => p.id));
    for (const u of state.instance.usage) {
      expect(providers.has(u.providerId), u.id).toBe(true);
      expect(u.at <= "2026-10-23T12:00:00Z", u.id).toBe(true);
    }
  });
});
