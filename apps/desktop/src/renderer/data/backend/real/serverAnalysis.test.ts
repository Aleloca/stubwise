import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me } from "./fakeServer";
import { instance } from "./instanceChat";
import { liveServerAnalysis } from "./serverAnalysis";

// I tetti dell'analisi dei server nella build app (registro, A8 r.964,
// `servers-analysis-limits`): Amministrazione → AI → Budget su
// GET/PUT /api/settings/server-analysis (`settings.manage`, 72). La forma è
// `serverAnalysisLimitsSchema` di `@stubwise/shared`; i rifiuti nelle parole
// del prototipo (`forbidden`, `invalid` col campo).

const LIMITS = { enabled: true, maxMinutes: 15, maxCostUsd: 2, maxAgentReads: 40, maxSshReads: 20 };

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i tetti dell'analisi dal server", () => {
  it("la lettura è quella del server", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/settings/server-analysis": { body: { ...LIMITS, maxMinutes: 7 } },
    });
    expect(await liveServerAnalysis.getServerAnalysisSettings()).toEqual({
      ...LIMITS,
      maxMinutes: 7,
    });
  });

  it("il namespace `instance` della build app li legge e li salva dal server (non «in arrivo»)", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/settings/server-analysis": { body: LIMITS },
      "PUT /api/settings/server-analysis": { body: LIMITS },
    });
    expect(await instance.getServerAnalysisSettings()).toEqual(LIMITS);
    expect(await instance.saveServerAnalysisSettings(LIMITS)).toEqual({ ok: true });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toContain("PUT /api/settings/server-analysis");
  });

  it("salvare manda il PUT coi tetti, e dice ok", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "PUT /api/settings/server-analysis": { body: { ...LIMITS, enabled: false } },
    });
    expect(
      await liveServerAnalysis.saveServerAnalysisSettings({ ...LIMITS, enabled: false }),
    ).toEqual({ ok: true });
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.path).toBe("/api/settings/server-analysis");
    expect(put?.body).toEqual({ ...LIMITS, enabled: false });
  });

  it("senza settings.manage: forbidden, in lettura e in scrittura", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/settings/server-analysis": {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
      "PUT /api/settings/server-analysis": {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
    });
    await expect(liveServerAnalysis.getServerAnalysisSettings()).rejects.toMatchObject({
      status: 403,
    });
    expect(await liveServerAnalysis.saveServerAnalysisSettings(LIMITS)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("un tetto fuori dai limiti: invalid col campo che il server nomina", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "PUT /api/settings/server-analysis": {
        status: 400,
        body: { code: "FST_ERR_VALIDATION", message: "body/maxCostUsd must be <= 20" },
      },
    });
    expect(
      await liveServerAnalysis.saveServerAnalysisSettings({ ...LIMITS, maxCostUsd: 999 }),
    ).toEqual({
      ok: false,
      error: "invalid",
      reason: "maxCostUsd",
    });
  });
});
