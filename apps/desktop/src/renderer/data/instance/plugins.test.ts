import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instance, resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission, type LocalInstancePermission } from "../viewer";
import type { InstanceResult } from "./types";

// Il registro dei plugin nel livello dati (area 9b, Task 4), coi timer
// finti: registrare un plugin lo mette «in preparazione», dopo
// `PLUGIN_STEP_MS` è pronto (o non riuscito) e lo smoke test parte, e dopo
// un altro passo è superato. Registrare e aggiornare chiedono la casella «Mi
// fido» e la riconferma; la casella si controlla prima della riconferma.

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const STEP = instance.PLUGIN_STEP_MS;

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);

const plugin = (slug: string) => state.instance.plugins.find((p) => p.slug === slug);
const kinds = () => state.changelog.map((e) => e.kind);

const register = (over: Partial<Parameters<typeof instance.registerPlugin>[0]> = {}) =>
  instance.registerPlugin({
    url: "https://github.com/acme/review-kit",
    ref: "v1.2.0",
    subdir: null,
    trusted: true,
    ...over,
  });

function snapshot(): string {
  return JSON.stringify({ plugins: state.instance.plugins, simulate: state.instance.simulate });
}

async function refused(
  call: () => Promise<InstanceResult<object>>,
  expected: Partial<{ error: string; reason: string }>,
) {
  const before = snapshot();
  const entries = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetApi();
  setLatency(0);
  state.changelog.splice(0);
  as(ROBERTA);
});
afterEach(() => {
  resetApi();
  vi.useRealTimers();
});

describe("ciclo di un plugin registrato", () => {
  it("materializing → dopo 800 ms ready con inventario e smoke in corso → poi superato", async () => {
    reauth(ROBERTA);
    const res = await register();
    expect(res).toMatchObject({ ok: true });
    const p = plugin("review-kit")!;
    expect(p).toMatchObject({
      name: "review-kit",
      url: "https://github.com/acme/review-kit",
      ref: "v1.2.0",
      status: "materializing",
      smoke: null,
      sha: null,
      inventory: null,
      registeredById: ROBERTA,
    });
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "plugin.registered",
      object: { type: "plugin", id: p.id, label: "review-kit" },
      params: { ref: "v1.2.0" },
    });

    await vi.advanceTimersByTimeAsync(STEP - 1);
    expect(plugin("review-kit")!.status).toBe("materializing");
    await vi.advanceTimersByTimeAsync(1);
    const ready = plugin("review-kit")!;
    expect(ready.status).toBe("ready");
    expect(ready.smoke).toBe("running");
    expect(ready.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ready.inventory!.skills.length).toBeGreaterThan(0);
    expect(ready.inventory!.hooks[0]!.key).toMatch(/^[A-Za-z]+#\d+$/);

    await vi.advanceTimersByTimeAsync(STEP);
    expect(plugin("review-kit")!.smoke).toBe("passed");
    // Le transizioni non sono modifiche di qualcuno: una sola voce.
    expect(kinds()).toEqual(["plugin.registered"]);
    // Le letture: elenco e pagina, con chi l'ha registrato per nome.
    const [row] = (await instance.listPlugins()).filter((x) => x.slug === "review-kit");
    expect(row).toMatchObject({
      status: "ready",
      smoke: "passed",
      registeredByName: "Roberta Fontana",
    });
    expect(await instance.getPlugin(p.id)).toMatchObject({ id: p.id, status: "ready" });
  });

  it("con «failed» simulato → failed con l'errore, e la volta dopo di nuovo pronto", async () => {
    reauth(ROBERTA);
    expect(await instance.simulateNextPluginOutcome("failed")).toEqual({ ok: true });
    await register();
    await vi.advanceTimersByTimeAsync(STEP);
    const p = plugin("review-kit")!;
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/\S/);
    expect(p.smoke).toBeNull();
    expect(p.inventory).toBeNull();

    // «Prova un altro ref»: l'esito simulato valeva una volta.
    expect(await instance.updatePluginRef(p.id, { ref: "v1.2.1", trusted: true })).toEqual({
      ok: true,
    });
    expect(plugin("review-kit")).toMatchObject({
      status: "materializing",
      error: null,
      ref: "v1.2.1",
    });
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "plugin.ref_updated",
      before: "v1.2.0",
      after: "v1.2.1",
    });
    await vi.advanceTimersByTimeAsync(STEP * 2);
    expect(plugin("review-kit")).toMatchObject({ status: "ready", smoke: "passed" });
  });

  it("resetApi a metà: la transizione non arriva", async () => {
    reauth(ROBERTA);
    const { pluginId } = (await register()) as { ok: true; pluginId: string };
    await vi.advanceTimersByTimeAsync(STEP / 2);
    resetApi();
    setLatency(0);
    // Un plugin con lo stesso id nello stato nuovo, in preparazione: non deve cambiare.
    state.instance.plugins.push({
      ...structuredClone(state.instance.plugins[0]!),
      id: pluginId,
      slug: "review-kit",
      status: "materializing",
      smoke: null,
    });
    const before = snapshot();
    await vi.advanceTimersByTimeAsync(STEP * 4);
    expect(plugin("review-kit")!.status).toBe("materializing");
    expect(snapshot()).toBe(before);
  });

  it("rimuovere un plugin in preparazione ferma la sua transizione", async () => {
    reauth(ROBERTA);
    const { pluginId } = (await register()) as { ok: true; pluginId: string };
    expect(await instance.removePlugin(pluginId)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(STEP * 4);
    expect(plugin("review-kit")).toBeUndefined();
    expect(kinds()).toEqual(["plugin.registered", "plugin.removed"]);
  });

  it("rifare lo smoke test: senza riconferma, solo su un plugin pronto", async () => {
    expect(await instance.rerunSmoke("plg-superpowers")).toEqual({ ok: true });
    expect(state.instance.plugins.find((p) => p.id === "plg-superpowers")!.smoke).toBe("running");
    await refused(() => instance.rerunSmoke("plg-superpowers"), { error: "conflict" });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(state.instance.plugins.find((p) => p.id === "plg-superpowers")!.smoke).toBe("passed");
    await refused(() => instance.rerunSmoke("plg-lint-helpers"), {
      error: "invalid",
      reason: "not_ready",
    });
    expect(kinds()).toEqual(["plugin.smoke_rerun"]);
  });
});

describe("le letture per la pagina (Task 10)", () => {
  it("busy finché si prepara o lo smoke gira; il nome nel risultato della registrazione", async () => {
    reauth(ROBERTA);
    const res = await register();
    expect(res).toMatchObject({ ok: true, name: "review-kit" });
    const view = async () =>
      (await instance.listPlugins()).find((p) => p.slug === "review-kit")!;
    expect((await view()).busy).toBe(true);
    await vi.advanceTimersByTimeAsync(STEP);
    expect(await view()).toMatchObject({ status: "ready", smoke: "running", busy: true });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(await view()).toMatchObject({ smoke: "passed", busy: false });
    expect((await instance.getPlugin(plugin("superpowers")!.id)).busy).toBe(false);
  });

  it("l'esito della prossima preparazione si legge, e torna «ready» dopo l'uso", async () => {
    reauth(ROBERTA);
    expect(await instance.getNextPluginOutcome()).toBe("ready");
    await instance.simulateNextPluginOutcome("failed");
    expect(await instance.getNextPluginOutcome()).toBe("failed");
    await register();
    expect(await instance.getNextPluginOutcome()).toBe("ready");
    as(MARCO);
    await expect(instance.getNextPluginOutcome()).rejects.toThrow("forbidden");
  });

  it("i rifiuti dicono il nome: quello non ammesso, e il plugin che ha già l'indirizzo", async () => {
    reauth(ROBERTA);
    expect(await register({ url: "https://github.com/acme/My_Plugin" })).toMatchObject({
      reason: "slug",
      name: "My_Plugin",
    });
    expect(await register({ url: "https://github.com/obra/superpowers.git" })).toMatchObject({
      reason: "duplicate",
      name: "superpowers",
    });
  });
});

describe("registrare: indirizzo, slug, duplicati", () => {
  it("http://, credenziali, git@ e indirizzi illeggibili → invalid", async () => {
    reauth(ROBERTA);
    for (const [url, reason] of [
      ["http://github.com/acme/review-kit", "https"],
      ["https://user:pw@github.com/acme/review-kit", "credentials"],
      ["https://token@github.com/acme/review-kit", "credentials"],
      ["git@github.com:acme/review-kit.git", "git_ssh"],
      ["ssh://git@github.com/acme/review-kit.git", "https"],
      ["not a url", "https"],
    ] as const)
      await refused(() => register({ url }), { error: "invalid", reason });
  });

  it("slug fuori dal pattern → invalid slug; .git e sottocartella", async () => {
    reauth(ROBERTA);
    await refused(() => register({ url: "https://github.com/acme/My_Plugin" }), {
      error: "invalid",
      reason: "slug",
    });
    await refused(() => register({ url: "https://github.com/" }), {
      error: "invalid",
      reason: "slug",
    });
    expect(
      await register({ url: "https://github.com/acme/tools.git", subdir: "plugins/lint-kit/" }),
    ).toMatchObject({
      ok: true,
    });
    expect(plugin("lint-kit")).toMatchObject({ subdir: "plugins/lint-kit" });
  });

  it("un indirizzo già registrato → invalid duplicate", async () => {
    reauth(ROBERTA);
    await refused(() => register({ url: "https://github.com/obra/superpowers" }), {
      error: "invalid",
      reason: "duplicate",
    });
    await refused(() => register({ url: "https://github.com/obra/superpowers.git/" }), {
      error: "invalid",
      reason: "duplicate",
    });
    await refused(() => register({ ref: " " }), { error: "invalid", reason: "ref" });
  });
});

describe("la casella «Mi fido» e la riconferma", () => {
  it("registerPlugin senza trusted: true → not_trusted, nessun plugin, nessuna voce, nessuna riconferma chiesta", async () => {
    // Nessuna riconferma recente: se la si chiedesse, l'esito sarebbe reauth_required.
    expect(state.reauth.has(ROBERTA)).toBe(false);
    await refused(
      () =>
        instance.registerPlugin({
          url: "https://github.com/acme/review-kit",
          ref: "v1",
          subdir: null,
          trusted: false as unknown as true,
        }),
      { error: "invalid", reason: "not_trusted" },
    );
    await refused(
      () =>
        instance.registerPlugin({
          url: "https://github.com/acme/review-kit",
          ref: "v1",
          subdir: null,
        } as unknown as Parameters<typeof instance.registerPlugin>[0]),
      { error: "invalid", reason: "not_trusted" },
    );
    expect(plugin("review-kit")).toBeUndefined();
  });

  it("updatePluginRef senza trusted: true → not_trusted, plugin invariato", async () => {
    await refused(
      () =>
        instance.updatePluginRef("plg-superpowers", {
          ref: "v4.1.0",
          trusted: false as unknown as true,
        }),
      { error: "invalid", reason: "not_trusted" },
    );
    expect(state.instance.plugins.find((p) => p.id === "plg-superpowers")!.ref).toBe("v4.0.3");
  });

  it("con la casella: senza riconferma → reauth_required; con → ok", async () => {
    await refused(() => register(), { error: "reauth_required" });
    await refused(
      () => instance.updatePluginRef("plg-superpowers", { ref: "v4.1.0", trusted: true }),
      { error: "reauth_required" },
    );
    reauth(ROBERTA);
    expect(await register()).toMatchObject({ ok: true });
    expect(
      await instance.updatePluginRef("plg-superpowers", { ref: "v4.1.0", trusted: true }),
    ).toEqual({ ok: true });
    // In preparazione: un secondo aggiornamento aspetta.
    await refused(
      () => instance.updatePluginRef("plg-superpowers", { ref: "v4.1.1", trusted: true }),
      { error: "conflict" },
    );
  });

  it("rimuovere e rifare lo smoke non chiedono né casella né riconferma", async () => {
    expect(await instance.rerunSmoke("plg-superpowers")).toEqual({ ok: true });
    expect(await instance.removePlugin("plg-lint-helpers")).toEqual({ ok: true });
  });
});

describe("permessi", () => {
  const writes: [string, () => Promise<InstanceResult<object>>][] = [
    ["registerPlugin", () => register()],
    [
      "updatePluginRef",
      () => instance.updatePluginRef("plg-superpowers", { ref: "v4.1.0", trusted: true }),
    ],
    ["rerunSmoke", () => instance.rerunSmoke("plg-superpowers")],
    ["removePlugin", () => instance.removePlugin("plg-superpowers")],
    ["simulateNextPluginOutcome", () => instance.simulateNextPluginOutcome("failed")],
  ];
  for (const [name, call] of writes)
    it(`${name} senza plugins.manage → forbidden`, async () => {
      reauth(MARCO);
      as(MARCO);
      await refused(call, { error: "forbidden" });
    });

  it("le letture chiedono plugins.manage; con il permesso si scrive", async () => {
    as(MARCO);
    await expect(instance.listPlugins()).rejects.toThrow("forbidden");
    await expect(instance.getPlugin("plg-superpowers")).rejects.toThrow("forbidden");
    grantInstancePermission(MARCO, "plugins.manage" as LocalInstancePermission);
    expect(await instance.listPlugins()).toHaveLength(2);
    await expect(instance.getPlugin("plg-nope")).rejects.toThrow("not_found");
    reauth(MARCO);
    expect(await register()).toMatchObject({ ok: true });
  });
});
