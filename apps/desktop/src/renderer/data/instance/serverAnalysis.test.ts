import { serverAnalysisLimitsSchema } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, resetApi, servers, setLatency } from "../api";
import { whenAnalysesIdle } from "../servers/analysis";
import { setSessionPersonId } from "../session";
import { eventsOf, state } from "../store";

// Area 8, F4b (R0-C, R6): i tetti dell'analisi dei server, in
// Amministrazione → AI (GET/PUT /api/settings/server-analysis sul server,
// `settings.manage`). La forma e i default sono quelli di
// `serverAnalysisLimitsSchema` di `@stubwise/shared`; l'analisi (automatica
// e a mano) li legge alla partenza.

const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
const DEFAULTS = serverAnalysisLimitsSchema.parse({});
const sshReads = (conversationId: string) =>
  eventsOf(conversationId).filter((e) => e.type === "action" && e.serverCommand?.via === "ssh");

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-roberta");
});
afterEach(async () => {
  await whenAnalysesIdle();
  resetApi();
});

describe("i tetti dell'analisi dei server (R0-C)", () => {
  it("di base quelli di shared; li legge e li scrive solo chi ha settings.manage", async () => {
    expect(await instance.getServerAnalysisSettings()).toEqual(DEFAULTS);
    as("p-marco");
    expect(await message(instance.getServerAnalysisSettings())).toBe("forbidden");
    expect(await instance.saveServerAnalysisSettings({ ...DEFAULTS, maxMinutes: 5 })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(state.instance.serverAnalysis).toEqual(DEFAULTS);
  });

  it("salvati, e il registro delle modifiche dice cosa è cambiato", async () => {
    const r = await instance.saveServerAnalysisSettings({
      ...DEFAULTS,
      maxMinutes: 5,
      maxSshReads: 4,
    });
    expect(r).toMatchObject({ ok: true });
    expect(await instance.getServerAnalysisSettings()).toEqual({
      ...DEFAULTS,
      maxMinutes: 5,
      maxSshReads: 4,
    });
    const entry = state.changelog.find((c) => c.kind === "server_analysis.changed")!;
    expect(entry).toMatchObject({ actorId: "p-roberta", projectId: null });
    expect(JSON.parse(entry.before!)).toEqual({ maxMinutes: "10", maxSshReads: "30" });
    expect(JSON.parse(entry.after!)).toEqual({ maxMinutes: "5", maxSshReads: "4" });
  });

  it("fuori dai limiti dello schema: rifiutato col campo, niente salvato", async () => {
    for (const [field, value] of [
      ["maxMinutes", 0],
      ["maxMinutes", 61],
      ["maxCostUsd", 0.05],
      ["maxCostUsd", 21],
      ["maxAgentReads", 201],
      ["maxSshReads", -1],
    ] as const) {
      expect(
        await instance.saveServerAnalysisSettings({ ...DEFAULTS, [field]: value }),
        `${field}=${value}`,
      ).toEqual({ ok: false, error: "invalid", reason: field });
    }
    expect(state.instance.serverAnalysis).toEqual(DEFAULTS);
  });

  it("l'analisi li legge: i minuti nella sessione, le letture SSH fino al tetto", async () => {
    await instance.saveServerAnalysisSettings({ ...DEFAULTS, maxMinutes: 5, maxSshReads: 1 });
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const a = state.serverAnalyses.find((x) => x.id.includes("-new-") && x.serverCode === "SRV-1")!;
    const c = state.conversations.find((x) => x.id === a.conversationId)!;
    expect(c.analysisLimits).toMatchObject({ maxMinutes: 5, maxCostUsd: DEFAULTS.maxCostUsd });
    expect(sshReads(c.id)).toHaveLength(1);
    const said = eventsOf(c.id)
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n");
    expect(said).toMatch(/at most 5 minutes/);
    expect(said).toMatch(/limit of 1 SSH read/);
  });

  it("spenta: l'allarme non la fa partire (e l'episodio lo ricorda); a mano `invalid: disabled`", async () => {
    await instance.saveServerAnalysisSettings({ ...DEFAULTS, enabled: false });
    const ep = await servers.simulateServerAlert("SRV-1", "memory");
    expect(ep.analysisId).toBeNull();
    expect(state.serverEpisodes.find((e) => e.id === ep.id)!.analysisBlocked).toBe("disabled");
    as("p-marco");
    expect(await message(servers.startServerAnalysis("SRV-1"))).toBe("invalid: disabled");
  });
});
