import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealProviders, type ProvidersApi } from "./aiProviders";

// Area 9, F3: AI → Providers sulle rotte di 72 (`/api/ai-providers`, 8c
// 76420b2d7) e sulla quota (`aiUsage.snapshots`).

const A = "50000000-0000-4000-8000-00000000000a";
const B = "50000000-0000-4000-8000-00000000000b";
const C = "50000000-0000-4000-8000-00000000000c";

const view = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "account",
  label: `P-${id.slice(-1)}`,
  position: 1,
  enabled: true,
  secretSet: true,
  createdAt: "2026-11-01T09:00:00.000Z",
  testStatus: "idle",
  testRequestedAt: null,
  testCheckedAt: null,
  testError: null,
  lastEnabled: false,
  last4: "9e2b",
  limitedUntil: null,
  quotaBand: "ok",
  ...over,
});

const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

function fakeApi(over: Partial<ProvidersApi> = {}) {
  const calls: string[] = [];
  const api: ProvidersApi = {
    list: async () => [
      view(A, { position: 1, quotaBand: "near" }),
      view(B, { position: 2, kind: "api_key", last4: null }),
      view(C, { position: 3, enabled: false }),
    ],
    snapshots: async () => [
      {
        providerId: A,
        capturedAt: "2026-11-18T08:00:00.000Z",
        sessionRemaining: { percentUsed: 82, percentRemaining: 18 },
        weeklyRemaining: { percentUsed: 40, percentRemaining: 60 },
      },
    ],
    create: async (input) => {
      calls.push(`create ${JSON.stringify(input)}`);
      return view("50000000-0000-4000-8000-00000000000d");
    },
    update: async (id, patch) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`);
      return view(id);
    },
    reorder: async (ids) => {
      calls.push(`reorder ${ids.map((i) => i.slice(-1)).join("")}`);
      return [];
    },
    test: async (id) => {
      calls.push(`test ${id}`);
      return view(id, { testStatus: "pending" });
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
    },
    wait: async () => undefined,
    ...over,
  };
  return { api, calls };
}

describe("i provider AI dal server (area 9, F3)", () => {
  it("l'elenco: nome, tipo del prototipo, ultime 4 (o niente), posizione, l'unico acceso dal server, la quota", async () => {
    const list = await createRealProviders(fakeApi().api).listProviders();
    expect(list.map((p) => [p.name, p.kind, p.last4, p.position])).toEqual([
      ["P-a", "subscription", "9e2b", 1],
      ["P-b", "api_key", "", 2],
      ["P-c", "subscription", "9e2b", 3],
    ]);
    expect(list[0]!.quota).toEqual({
      fiveHourPct: 82,
      weeklyPct: 40,
      readAt: "2026-11-18T08:00:00.000Z",
      band: "near",
      limitedUntil: null,
    });
    expect(list[1]!.quota).toBeNull();
    const only = await createRealProviders(
      fakeApi({
        list: async () => [view(A, { lastEnabled: true })],
        snapshots: refusing(403, "forbidden"),
      }).api,
    ).listProviders();
    expect(only[0]).toMatchObject({ lastEnabled: true, quota: null });
  });

  it("un tipo che il client non conosce si legge come chiave API (review F3, M4)", async () => {
    const [p] = await createRealProviders(
      fakeApi({ list: async () => [view(A, { kind: "__unknown__" })], snapshots: async () => [] })
        .api,
    ).listProviders();
    expect(p!.kind).toBe("api_key");
  });

  it("le scritture: crea col tipo del server, rinomina, accende, sostituisce, elimina; riordina con TUTTI gli id", async () => {
    const { api, calls } = fakeApi();
    const p = createRealProviders(api);
    expect(
      await p.createProvider({ name: " Team ", kind: "subscription", credential: "tok" }),
    ).toEqual({
      ok: true,
      providerId: "50000000-0000-4000-8000-00000000000d",
    });
    expect(await p.renameProvider(B, " Billing ")).toEqual({ ok: true });
    expect(await p.setProviderEnabled(C, true)).toEqual({ ok: true });
    expect(await p.replaceProviderCredential(B, "sk-new")).toEqual({ ok: true });
    expect(await p.moveProvider(C, 0)).toEqual({ ok: true });
    expect(await p.deleteProvider(C)).toEqual({ ok: true });
    expect(calls).toEqual([
      'create {"kind":"account","label":"Team","secret":"tok"}',
      `update ${B} {"label":"Billing"}`,
      `update ${C} {"enabled":true}`,
      `update ${B} {"secret":"sk-new"}`,
      "reorder cab",
      `remove ${C}`,
    ]);
  });

  it("l'ultimo acceso, la riconferma, il nome già usato: nelle parole del prototipo", async () => {
    const last = createRealProviders(
      fakeApi({ update: refusing(409, "last_enabled_provider") }).api,
    );
    expect(await last.setProviderEnabled(A, false)).toEqual({
      ok: false,
      error: "invalid",
      reason: "last_enabled_provider",
    });
    const reauth = createRealProviders(fakeApi({ create: refusing(403, "reauth_required") }).api);
    expect(await reauth.createProvider({ name: "X", kind: "api_key", credential: "k" })).toEqual({
      ok: false,
      error: "reauth_required",
    });
  });

  it("la prova: chiesta, poi riletta finché non è più pending; failed è «credenziale non valida»", async () => {
    let reads = 0;
    const passing = createRealProviders(
      fakeApi({
        list: async () => [
          view(
            A,
            reads++ < 2
              ? { testStatus: "pending" }
              : { testStatus: "passed", testCheckedAt: "2026-11-18T09:00:00.000Z" },
          ),
        ],
      }).api,
    );
    expect(await passing.testProvider(A)).toEqual({ ok: true, outcome: "ok" });
    expect(reads).toBe(3);
    const failing = createRealProviders(
      fakeApi({ list: async () => [view(A, { testStatus: "failed", testError: "401" })] }).api,
    );
    expect(await failing.testProvider(A)).toEqual({ ok: true, outcome: "invalid_credentials" });
    const stuck = createRealProviders(
      fakeApi({ list: async () => [view(A, { testStatus: "pending" })] }).api,
    );
    expect(await stuck.testProvider(A)).toEqual({
      ok: false,
      error: "invalid",
      reason: "test_pending",
    });
  });
});
