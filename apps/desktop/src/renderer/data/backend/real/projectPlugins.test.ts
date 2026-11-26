import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealProjectPlugins, type ProjectPluginsApi } from "./projectPlugins";

// Area 9, F5: Progetto → Settings → Plugins su `/api/projects/:id/plugins`
// (72, f5677875b, a19c56d09): le scelte del progetto, il registro (ogni
// plugin, in ogni stato) e la versione per `ifMatch`. Sul server un plugin
// entra nei run solo se è acceso sul progetto (`enabled`) e pronto; dentro,
// per sottrazione. Il salvataggio rimanda ogni riga com'era (`enabled`
// compreso) con le liste di spenti nuove dei plugin che la pagina sceglie.

const SP = "11111111-1111-4111-8111-111111111111";
const LH = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

const REGISTRY = [
  {
    pluginId: SP,
    slug: "superpowers",
    name: "superpowers",
    status: "ready",
    skills: ["brainstorming", "writing-plans", "using-git-worktrees"],
    hookGroups: ["SessionStart#0"],
    recommendedDisabledSkills: ["using-git-worktrees"],
  },
  {
    pluginId: LH,
    slug: "lint-helpers",
    name: "lint-helpers",
    status: "failed",
    skills: ["fix-lint"],
    hookGroups: [],
    recommendedDisabledSkills: [],
  },
  {
    pluginId: NEW,
    slug: "nuovo",
    name: "nuovo",
    status: "ready",
    skills: ["one"],
    hookGroups: [],
    recommendedDisabledSkills: [],
  },
];

const GET = {
  version: "v7",
  canEdit: true,
  plugins: [
    { pluginId: SP, enabled: true, disabledSkills: ["brainstorming"], disabledHooks: [] },
    { pluginId: LH, enabled: true, disabledSkills: ["fix-lint"], disabledHooks: [] },
  ],
  registry: REGISTRY,
};

function fake(over: Partial<ProjectPluginsApi> = {}) {
  const puts: { plugins: unknown; ifMatch: string | null | undefined }[] = [];
  const api: ProjectPluginsApi = {
    get: async () => GET,
    put: async (_id, plugins, ifMatch) => {
      puts.push({ plugins, ifMatch });
      return { ...GET, version: "v8", plugins };
    },
    ...over,
  };
  return { api, puts };
}

describe("i plugin del progetto dal server", () => {
  // Rimandi, lotto 5, voce 6 (72, 2fb6472c6): le descrizioni delle skill a
  // tutti; i comandi degli hook solo a chi può salvare (decisione di 46): a
  // chi legge arrivano `{}`, e vede il gruppo.
  it("descrizioni delle skill e comandi degli hook dal server", async () => {
    const withText = (canEdit: boolean) =>
      fake({
        get: async () => ({
          ...GET,
          canEdit,
          registry: REGISTRY.map((r) =>
            r.pluginId === SP
              ? {
                  ...r,
                  skillDescriptions: { "writing-plans": "Write the plan first" },
                  hookCommands: canEdit ? { "SessionStart#0": ["a.sh", "b.sh"] } : {},
                }
              : r,
          ),
        }),
      }).api;
    const editor = (await createRealProjectPlugins(withText(true)).getProjectPlugins("p1"))!;
    const sp = editor.plugins.find((p) => p.name === "superpowers")!;
    expect(sp.skills.find((s) => s.name === "writing-plans")!.description).toBe(
      "Write the plan first",
    );
    expect(sp.skills.find((s) => s.name === "brainstorming")!.description).toBe("");
    expect(sp.hooks[0]!.command).toBe("a.sh\nb.sh");
    const reader = (await createRealProjectPlugins(withText(false)).getProjectPlugins("p1"))!;
    const spr = reader.plugins.find((p) => p.name === "superpowers")!;
    expect(spr.hooks[0]!.command).toBe("");
    expect(spr.skills.find((s) => s.name === "writing-plans")!.description).toBe(
      "Write the plan first",
    );
  });

  it("la lettura: il registro con le scelte, nei run solo se acceso e pronto", async () => {
    const view = (await createRealProjectPlugins(fake().api).getProjectPlugins("p1"))!;
    expect(view.version).toBe("v7");
    expect(view.canEdit).toBe(true);
    const [sp, lh, nuovo] = view.plugins;
    expect(sp).toMatchObject({
      name: "superpowers",
      status: "ready",
      base: false,
      on: true,
      inRuns: true,
    });
    expect(sp!.skills).toEqual([
      { name: "brainstorming", description: "", enabled: false },
      { name: "writing-plans", description: "", enabled: true },
      { name: "using-git-worktrees", description: "", enabled: true },
    ]);
    expect(sp!.hooks).toEqual([
      { key: "SessionStart#0", event: "SessionStart", command: "", enabled: true },
    ]);
    expect(sp!.preset).toEqual(["using-git-worktrees"]);
    expect(lh).toMatchObject({ status: "failed", on: true, inRuns: false, preset: null });
    // Un plugin nuovo, mai acceso sul progetto, sul server non entra nei run.
    expect(nuovo).toMatchObject({ status: "ready", on: false, inRuns: false });
  });

  it("F5 review, I2: chi può cambiare lo dice il server (`canEdit`); senza il campo, sola lettura", async () => {
    const read = (body: unknown) =>
      createRealProjectPlugins(fake({ get: async () => body }).api).getProjectPlugins("p1");
    expect((await read({ ...GET, canEdit: false }))!.canEdit).toBe(false);
    const withoutField: Record<string, unknown> = { ...GET };
    delete withoutField.canEdit;
    expect((await read(withoutField))!.canEdit).toBe(false);
    expect((await read(GET))!.canEdit).toBe(true);
  });

  it("un progetto che non si vede, o senza il permesso: null", async () => {
    const refusing = (status: number) => async () => {
      throw new ApiError(status, "x", status === 404 ? "not_found" : "forbidden");
    };
    expect(
      await createRealProjectPlugins(fake({ get: refusing(404) }).api).getProjectPlugins("p1"),
    ).toBeNull();
    expect(
      await createRealProjectPlugins(fake({ get: refusing(403) }).api).getProjectPlugins("p1"),
    ).toBeNull();
  });

  it("il salvataggio: ifMatch con la versione letta; ogni riga com'era, le liste nuove", async () => {
    const { api, puts } = fake();
    const result = await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      disabled: [
        { plugin: "superpowers", skills: ["writing-plans"], hookGroups: ["SessionStart#0"] },
      ],
    });
    expect(result).toEqual({ ok: true, version: "v8" });
    expect(puts).toEqual([
      {
        ifMatch: "v7",
        plugins: [
          {
            pluginId: SP,
            enabled: true,
            disabledSkills: ["writing-plans"],
            disabledHooks: ["SessionStart#0"],
          },
          // Un plugin non pronto non si sceglie: la sua riga resta com'era.
          { pluginId: LH, enabled: true, disabledSkills: ["fix-lint"], disabledHooks: [] },
        ],
      },
    ]);
  });

  it("un plugin pronto mai salvato, se la pagina ne spegne qualcosa, si salva spento sul progetto", async () => {
    const { api, puts } = fake();
    await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      disabled: [
        { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
        { plugin: "nuovo", skills: ["one"], hookGroups: [] },
      ],
    });
    expect(puts[0]!.plugins).toContainEqual({
      pluginId: NEW,
      enabled: false,
      disabledSkills: ["one"],
      disabledHooks: [],
    });
  });

  it("F5, opt-in: `enabled` accende i pronti nominati e spegne gli altri; un non pronto resta com'era", async () => {
    const { api, puts } = fake();
    await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      enabled: ["nuovo"],
      disabled: [
        { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
        { plugin: "nuovo", skills: [], hookGroups: [] },
      ],
    });
    expect(puts[0]!.plugins).toEqual([
      { pluginId: SP, enabled: false, disabledSkills: ["brainstorming"], disabledHooks: [] },
      { pluginId: LH, enabled: true, disabledSkills: ["fix-lint"], disabledHooks: [] },
      { pluginId: NEW, enabled: true, disabledSkills: [], disabledHooks: [] },
    ]);
    // Acceso senza una riga fra gli spenti: si salva lo stesso, tutto acceso dentro.
    await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      enabled: ["superpowers", "nuovo"],
      disabled: [],
    });
    expect(puts[1]!.plugins).toContainEqual({
      pluginId: NEW,
      enabled: true,
      disabledSkills: [],
      disabledHooks: [],
    });
    expect(puts[1]!.plugins).toContainEqual({
      pluginId: SP,
      enabled: true,
      disabledSkills: [],
      disabledHooks: [],
    });
  });

  it("F5: un nome acceso fuori dal registro (anche il plugin base) → invalid, niente scritto", async () => {
    const { api, puts } = fake();
    for (const name of ["stubwise", "inventato"])
      expect(
        await createRealProjectPlugins(api).saveProjectPlugins("p1", {
          version: "v7",
          enabled: [name],
          disabled: [],
        }),
      ).toMatchObject({ ok: false, error: "invalid", reason: "plugin" });
    expect(puts).toEqual([]);
  });

  it("F5 review, I1: ogni riga si salva filtrata sull'inventario ATTUALE (ruling T10), anche le non pronte", async () => {
    const { api, puts } = fake({
      get: async () => ({
        ...GET,
        plugins: [
          {
            pluginId: SP,
            enabled: true,
            disabledSkills: ["brainstorming", "tolta-dallo-sha"],
            disabledHooks: ["Stop#3"],
          },
          {
            pluginId: LH,
            enabled: true,
            disabledSkills: ["fix-lint", "vecchia"],
            disabledHooks: ["X#0"],
          },
          // Un plugin tolto dal registro: la riga non si rimanda (il server la rifiuterebbe).
          {
            pluginId: "44444444-4444-4444-8444-444444444444",
            enabled: true,
            disabledSkills: [],
            disabledHooks: [],
          },
        ],
      }),
    });
    await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      disabled: [
        // Una scelta già salvata fuori dall'inventario si scarta, senza invalid.
        {
          plugin: "superpowers",
          skills: ["brainstorming", "tolta-dallo-sha"],
          hookGroups: ["Stop#3"],
        },
      ],
    });
    expect(puts[0]!.plugins).toEqual([
      { pluginId: SP, enabled: true, disabledSkills: ["brainstorming"], disabledHooks: [] },
      { pluginId: LH, enabled: true, disabledSkills: ["fix-lint"], disabledHooks: [] },
    ]);
  });

  it("F5 review, I1: un 400 unknown_plugin* (l'inventario è cambiato nel frattempo) → conflict, che rilegge", async () => {
    for (const code of ["unknown_plugin_skill", "unknown_plugin_hook", "unknown_plugin"]) {
      const { api } = fake({
        put: async () => {
          throw new ApiError(400, "x", code);
        },
      });
      expect(
        await createRealProjectPlugins(api).saveProjectPlugins("p1", {
          version: "v7",
          disabled: [],
        }),
      ).toEqual({ ok: false, error: "conflict" });
    }
  });

  it("review F5, M3: il registro si legge per slug, non per nome (due plugin col nome del manifest uguale)", async () => {
    const FORK = "55555555-5555-4555-8555-555555555555";
    const { api, puts } = fake({
      get: async () => ({
        ...GET,
        plugins: [],
        registry: [
          REGISTRY[0],
          {
            ...REGISTRY[0],
            pluginId: FORK,
            slug: "superpowers-fork",
            skills: ["brainstorming"],
            hookGroups: [],
          },
        ],
      }),
    });
    const view = (await createRealProjectPlugins(api).getProjectPlugins("p1"))!;
    expect(view.plugins.map((p) => [p.name, p.slug])).toEqual([
      ["superpowers", "superpowers"],
      ["superpowers", "superpowers-fork"],
    ]);
    await createRealProjectPlugins(api).saveProjectPlugins("p1", {
      version: "v7",
      enabled: ["superpowers-fork"],
      disabled: [{ plugin: "superpowers-fork", skills: ["brainstorming"], hookGroups: [] }],
    });
    expect(puts[0]!.plugins).toEqual([
      { pluginId: FORK, enabled: true, disabledSkills: ["brainstorming"], disabledHooks: [] },
    ]);
  });

  it("409 stale → conflict; un nome sconosciuto → invalid", async () => {
    const stale = fake({
      put: async () => {
        throw new ApiError(409, "stale", "stale");
      },
    });
    expect(
      await createRealProjectPlugins(stale.api).saveProjectPlugins("p1", {
        version: "v6",
        disabled: [],
      }),
    ).toEqual({ ok: false, error: "conflict" });
    const { api, puts } = fake();
    expect(
      await createRealProjectPlugins(api).saveProjectPlugins("p1", {
        version: "v7",
        disabled: [{ plugin: "inventato", skills: [], hookGroups: [] }],
      }),
    ).toMatchObject({ ok: false, error: "invalid", reason: "plugin" });
    expect(puts).toEqual([]);
  });
});
