import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealPlugins, type PluginsApi } from "./plugins";

// Area 9, F3: Amministrazione → Plugins su `/api/plugins` (72).

const P = "80000000-0000-4000-8000-000000000001";
const plugin = (over: Record<string, unknown> = {}) => ({
  id: P,
  slug: "superpowers",
  name: "superpowers",
  sourceUrl: "https://github.com/obra/superpowers",
  sourceSubdir: null,
  ref: "v4.0.3",
  resolvedSha: "a1b2c3d",
  status: "ready",
  inventory: {
    name: "superpowers",
    skills: [{ name: "tdd", description: "Test first", bytes: 10 }],
    commands: [],
    agents: [],
    hooks: [{ key: "SessionStart#0", event: "SessionStart", command: "echo" }],
    hasMcp: false,
  },
  error: null,
  smokeStatus: "passed",
  smokeError: null,
  pendingJobKind: null,
  materializedAt: "2026-11-01T09:00:00.000Z",
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-02T08:00:00.000Z",
  ...over,
});
const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

function fakeApi(over: Partial<PluginsApi> = {}) {
  const calls: string[] = [];
  const api: PluginsApi = {
    list: async () => ({ plugins: [plugin()], recommendations: {} }),
    get: async () => plugin(),
    register: async (input) => {
      calls.push(`register ${JSON.stringify(input)}`);
      return plugin({ id: "80000000-0000-4000-8000-000000000002", name: "new", status: "none" });
    },
    updateRef: async (id, ref, trust) => {
      calls.push(`update ${id} ${ref} ${trust}`);
      return { queued: true };
    },
    rerunSmoke: async (id) => {
      calls.push(`smoke ${id}`);
      return { queued: true };
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("i plugin dal server (area 9, F3)", () => {
  it("la forma del prototipo: stato, smoke, sha, inventario; busy dal job in coda", async () => {
    const p = createRealPlugins(fakeApi().api);
    const [a] = await p.listPlugins();
    expect(a).toMatchObject({
      id: P,
      name: "superpowers",
      url: "https://github.com/obra/superpowers",
      ref: "v4.0.3",
      sha: "a1b2c3d",
      subdir: null,
      status: "ready",
      smoke: "passed",
      busy: false,
      inventory: {
        skills: [{ name: "tdd", description: "Test first" }],
        hooks: [{ key: "SessionStart#0", event: "SessionStart", command: "echo" }],
      },
    });
    const queued = createRealPlugins(
      fakeApi({
        get: async () =>
          plugin({ status: "none", smokeStatus: "idle", pendingJobKind: "materialize" }),
      }).api,
    );
    expect(await queued.getPlugin(P)).toMatchObject({
      status: "materializing",
      smoke: null,
      busy: true,
    });
  });

  it("registrare e aggiornare mandano «Mi fido»; smoke e rimozione; il nome del nuovo", async () => {
    const { api, calls } = fakeApi();
    const p = createRealPlugins(api);
    expect(
      await p.registerPlugin({
        url: "https://github.com/x/y",
        ref: "main",
        subdir: null,
        trusted: true,
      }),
    ).toEqual({ ok: true, pluginId: "80000000-0000-4000-8000-000000000002", name: "new" });
    expect(await p.updatePluginRef(P, { ref: "v4.1.0", trusted: true })).toEqual({ ok: true });
    expect(await p.rerunSmoke(P)).toEqual({ ok: true });
    expect(await p.removePlugin(P)).toEqual({ ok: true });
    expect(calls).toEqual([
      'register {"sourceUrl":"https://github.com/x/y","ref":"main","trust":true}',
      `update ${P} v4.1.0 true`,
      `smoke ${P}`,
      `remove ${P}`,
    ]);
  });

  it("i rifiuti: in uso, riconferma, la «Mi fido» che manca, un plugin che non c'è", async () => {
    const inUse = createRealPlugins(fakeApi({ remove: refusing(409, "plugin_in_use") }).api);
    expect(await inUse.removePlugin(P)).toEqual({
      ok: false,
      error: "invalid",
      reason: "plugin_in_use",
    });
    const reauth = createRealPlugins(fakeApi({ register: refusing(403, "reauth_required") }).api);
    expect(
      await reauth.registerPlugin({
        url: "https://github.com/x/y",
        ref: "main",
        subdir: null,
        trusted: true,
      }),
    ).toEqual({ ok: false, error: "reauth_required" });
    const trust = createRealPlugins(fakeApi({ updateRef: refusing(422, "trust_required") }).api);
    expect(await trust.updatePluginRef(P, { ref: "x", trusted: true })).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_trusted",
    });
    const gone = createRealPlugins(fakeApi({ get: refusing(404, "not_found") }).api);
    await expect(gone.getPlugin(P)).rejects.toThrow("not_found");
  });
});
