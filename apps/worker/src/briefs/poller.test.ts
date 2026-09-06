import { activityReports, projectBriefs, projects, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../agent/runner.js";
import { BRIEF_MARKERS } from "./prompt.js";
import {
  BRIEF_MAX_ATTEMPTS,
  isInBriefWindow,
  pollBriefsOnce,
  previousWeekPeriod,
  startBriefPoller,
  type BriefPollerDeps,
} from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(projects);
  await db.delete(users);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.stop();
});

/** Lunedì 7 settembre 2026, 09:30 a Roma (07:30 UTC). */
const MONDAY_9_30 = new Date("2026-09-07T07:30:00.000Z");
const WINDOW = { timezone: "Europe/Rome", weekday: 1, hour: 9 };

const AGENT_OUTPUT = [
  BRIEF_MARKERS.whereWeAre,
  "Il progetto è a metà del lavoro sul login.",
  BRIEF_MARKERS.whatChanged,
  "- L'accesso funziona di nuovo.",
  BRIEF_MARKERS.whatBlocks,
  "Niente è fermo.",
  BRIEF_MARKERS.whatWeNeed,
  "Niente, per ora.",
].join("\n");

/** Runner finto: risponde sempre lo stesso testo con exit 0. */
function fakeRunner(output = AGENT_OUTPUT, exitCode = 0): AgentRunner & { calls: number } {
  const runner = {
    calls: 0,
    async run() {
      runner.calls++;
      return { output, exitCode };
    },
  };
  return runner as AgentRunner & { calls: number };
}

const PROVIDER = { id: "p1", kind: "anthropic_api_key", env: {} } as never;

function deps(over: Partial<BriefPollerDeps> = {}): BriefPollerDeps {
  return {
    db,
    runner: fakeRunner(),
    encryptionKey: Buffer.alloc(32),
    publicUrl: "https://stubwise.example.com",
    window: WINDOW,
    agentTimeoutMs: 60_000,
    staleMinutes: 30,
    now: () => MONDAY_9_30,
    logger: { info: () => {}, error: () => {} },
    // Provider risolto: nessuna credenziale vera nei test.
    loadProviderChainFn: async () => [PROVIDER],
    loadProviderByIdFn: async () => PROVIDER,
    ...over,
  } as BriefPollerDeps;
}

async function enabledProject(): Promise<string> {
  const { projectId } = await seedRepository(db);
  await db.update(projects).set({ weeklyBriefEnabled: true }).where(eq(projects.id, projectId));
  return projectId;
}

async function briefRows(projectId: string) {
  return db.select().from(projectBriefs).where(eq(projectBriefs.projectId, projectId));
}

describe("isInBriefWindow", () => {
  it("lunedì alle 9:30 a Roma: dentro", () => {
    expect(isInBriefWindow(MONDAY_9_30, WINDOW)).toBe(true);
  });

  it("martedì alla stessa ora: fuori (è un brief settimanale, non giornaliero)", () => {
    expect(isInBriefWindow(new Date("2026-09-08T07:30:00.000Z"), WINDOW)).toBe(false);
  });

  it("lunedì un'ora prima: fuori (la finestra è [ora, ora+1))", () => {
    expect(isInBriefWindow(new Date("2026-09-07T06:30:00.000Z"), WINDOW)).toBe(false);
  });

  it("la domenica è il giorno 7, non lo 0", () => {
    const sunday = new Date("2026-09-06T07:30:00.000Z");
    expect(isInBriefWindow(sunday, { ...WINDOW, weekday: 7 })).toBe(true);
    expect(isInBriefWindow(sunday, { ...WINDOW, weekday: 1 })).toBe(false);
  });

  it("il fuso decide il giorno: mezzanotte e mezza a Roma è ancora domenica a Londra", () => {
    const at = new Date("2026-09-06T23:30:00.000Z"); // lunedì 01:30 a Roma
    expect(isInBriefWindow(at, { timezone: "Europe/Rome", weekday: 1, hour: 1 })).toBe(true);
    expect(isInBriefWindow(at, { timezone: "UTC", weekday: 1, hour: 1 })).toBe(false);
  });

  it("fuso invalido: LANCIA, non degrada su UTC in silenzio", () => {
    expect(() => isInBriefWindow(MONDAY_9_30, { ...WINDOW, timezone: "Marte/Olympus" })).toThrow();
  });
});

describe("previousWeekPeriod", () => {
  it("dal lunedì d'invio: i sette giorni che finiscono ieri", () => {
    expect(previousWeekPeriod(MONDAY_9_30, "Europe/Rome")).toEqual({
      periodStart: "2026-08-31",
      periodEnd: "2026-09-06",
    });
  });

  it("il periodo si calcola nel FUSO, non in UTC", () => {
    // Lunedì 00:30 a Roma è ancora domenica 22:30 UTC.
    const at = new Date("2026-09-06T22:30:00.000Z");
    expect(previousWeekPeriod(at, "Europe/Rome").periodEnd).toBe("2026-09-06");
    expect(previousWeekPeriod(at, "UTC").periodEnd).toBe("2026-09-05");
  });
});

describe("pollBriefsOnce", () => {
  it("progetto abilitato, dentro la finestra: brief `done` con summary e sezioni", async () => {
    const projectId = await enabledProject();
    await db.insert(activityReports).values({
      projectId,
      date: "2026-09-01",
      status: "done",
      summary: "Il team ha sistemato il login.",

    });

    expect(await pollBriefsOnce(deps())).toBe(1);

    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({
      status: "done",
      periodStart: "2026-08-31",
      periodEnd: "2026-09-06",
      attempts: 1,
    });
    expect(row!.summary).toContain("Il progetto è a metà del lavoro sul login.");
    expect(row!.sections).toMatchObject({ whereWeAre: "Il progetto è a metà del lavoro sul login." });
    expect(row!.finishedAt).not.toBeNull();
  });

  it("fuori dalla finestra: nessun brief nuovo", async () => {
    await enabledProject();
    const tuesday = new Date("2026-09-08T07:30:00.000Z");
    expect(await pollBriefsOnce(deps({ now: () => tuesday }))).toBe(0);
    expect(await db.select().from(projectBriefs)).toEqual([]);
  });

  it("progetto NON abilitato: nessun brief", async () => {
    const { projectId } = await seedRepository(db);
    expect(await pollBriefsOnce(deps())).toBe(0);
    expect(await briefRows(projectId)).toEqual([]);
  });

  it("brief della settimana già `done`: il secondo tick non ne fa un altro", async () => {
    const projectId = await enabledProject();
    await pollBriefsOnce(deps());
    const runner = fakeRunner();
    expect(await pollBriefsOnce(deps({ runner }))).toBe(0);
    expect(runner.calls).toBe(0);
    expect(await briefRows(projectId)).toHaveLength(1);
  });

  it("provider assente: brief `done` con summary NULL, e nessun run dell'agente", async () => {
    const projectId = await enabledProject();
    const runner = fakeRunner();
    const n = await pollBriefsOnce(
      deps({ runner, loadProviderChainFn: async () => [], loadProviderByIdFn: async () => null }),
    );
    expect(n).toBe(1);
    expect(runner.calls).toBe(0);
    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({ status: "done", summary: null, sections: null });
  });

  it("run fallito: attempts sale e il brief torna in coda, non muore al primo colpo", async () => {
    const projectId = await enabledProject();
    await pollBriefsOnce(deps({ runner: fakeRunner("", 1) }));
    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row!.error).not.toBeNull();
  });

  it("al terzo tentativo fallito il brief è `failed` e non si ritenta più", async () => {
    const projectId = await enabledProject();
    for (let i = 0; i < BRIEF_MAX_ATTEMPTS; i++) {
      await pollBriefsOnce(deps({ runner: fakeRunner("", 1) }));
    }
    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({ status: "failed", attempts: BRIEF_MAX_ATTEMPTS });

    const runner = fakeRunner();
    await pollBriefsOnce(deps({ runner }));
    expect(runner.calls).toBe(0);
  });

  it("un `running` STANTIO viene recuperato e rigenerato (worker morto a metà)", async () => {
    const projectId = await enabledProject();
    await db.insert(projectBriefs).values({
      projectId,
      periodStart: "2026-08-31",
      periodEnd: "2026-09-06",
      status: "running",
      attempts: 1,
      lastActivityAt: new Date(MONDAY_9_30.getTime() - 60 * 60_000),
    });

    expect(await pollBriefsOnce(deps())).toBe(1);
    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({ status: "done", attempts: 2 });
  });

  it("un `running` FRESCO non viene toccato: è un altro tick che sta lavorando", async () => {
    const projectId = await enabledProject();
    await db.insert(projectBriefs).values({
      projectId,
      periodStart: "2026-08-31",
      periodEnd: "2026-09-06",
      status: "running",
      attempts: 1,
      lastActivityAt: new Date(MONDAY_9_30.getTime() - 60_000),
    });
    const runner = fakeRunner();
    expect(await pollBriefsOnce(deps({ runner }))).toBe(0);
    expect(runner.calls).toBe(0);
    expect((await briefRows(projectId))[0]).toMatchObject({ status: "running" });
  });

  it("un brief `queued` a mano viene generato ANCHE fuori dalla finestra", async () => {
    const projectId = await enabledProject();
    await db.insert(projectBriefs).values({
      projectId,
      periodStart: "2026-08-24",
      periodEnd: "2026-08-30",
      status: "queued",
    });
    const tuesday = new Date("2026-09-08T07:30:00.000Z");
    expect(await pollBriefsOnce(deps({ now: () => tuesday }))).toBe(1);
    const [row] = await briefRows(projectId);
    expect(row).toMatchObject({ status: "done", periodStart: "2026-08-24" });
  });

  it("un progetto che esplode non ferma gli altri", async () => {
    await enabledProject();
    const good = await enabledProject();
    let first = true;
    const runner = {
      async run() {
        if (first) {
          first = false;
          throw new Error("spawn fallito");
        }
        return { output: AGENT_OUTPUT, exitCode: 0 };
      },
    } as unknown as AgentRunner;
    expect(await pollBriefsOnce(deps({ runner }))).toBe(1);
    expect((await briefRows(good))[0]!.status).toBeDefined();
  });
});

describe("startBriefPoller", () => {
  it("intervalMinutes 0: NESSUN timer, è il rollback innocuo della feature", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = startBriefPoller({
      ...deps(),
      intervalMinutes: 0,
      signal: new AbortController().signal,
    });
    expect(spy).not.toHaveBeenCalled();
    stop();
  });

  it("intervalMinutes > 0: avvia un timer e si ferma sull'AbortSignal", () => {
    const spy = vi.spyOn(globalThis, "clearInterval");
    const controller = new AbortController();
    startBriefPoller({ ...deps(), intervalMinutes: 15, signal: controller.signal });
    controller.abort();
    expect(spy).toHaveBeenCalled();
  });
});
