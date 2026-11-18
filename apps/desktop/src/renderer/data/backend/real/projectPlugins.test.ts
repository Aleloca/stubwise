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
  it("la lettura: il registro con le scelte, nei run solo se acceso e pronto", async () => {
    const view = (await createRealProjectPlugins(fake().api).getProjectPlugins("p1"))!;
    expect(view.version).toBe("v7");
    expect(view.canEdit).toBe(true);
    const [sp, lh, nuovo] = view.plugins;
    expect(sp).toMatchObject({ name: "superpowers", status: "ready", base: false, inRuns: true });
    expect(sp!.skills).toEqual([
      { name: "brainstorming", description: "", enabled: false },
      { name: "writing-plans", description: "", enabled: true },
      { name: "using-git-worktrees", description: "", enabled: true },
    ]);
    expect(sp!.hooks).toEqual([
      { key: "SessionStart#0", event: "SessionStart", command: "", enabled: true },
    ]);
    expect(sp!.preset).toEqual(["using-git-worktrees"]);
    expect(lh).toMatchObject({ status: "failed", inRuns: false, preset: null });
    // Un plugin nuovo, mai acceso sul progetto, sul server non entra nei run.
    expect(nuovo).toMatchObject({ status: "ready", inRuns: false });
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
