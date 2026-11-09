import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCommands, projectSettings, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// I plugin del progetto, livello dati (area 9c, Task 4). Il registro è
// quello dell'istanza: superpowers (`ready`, 9 skill, un gruppo di hook) e
// lint-helpers (`failed`). Il plugin base `stubwise` sta fuori dal registro
// e non si spegne. Persone: Laura (Project Lead in ACQ, con
// `project.settings.manage`), Sara (Contributor in ACQ, senza).

const LAURA = "p-laura";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const ZNC = "prj-znc";
const RNC = "prj-rnc";

const as = (personId: string) => setSessionPersonId(personId);
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const choicesOf = (projectId: string) => state.projectSettings.get(projectId)!.plugins;
const runSkills = (projectId: string) =>
  projectSettings.skillsForRun(projectId).map((s) => `${s.plugin}:${s.skill}`);

beforeEach(() => {
  setLatency(0);
  resetApi();
  seeded = state.changelog.length;
});
afterEach(() => resetApi());

describe("la lettura dei plugin del progetto", () => {
  it("Laura in ACQ: il plugin base, poi il registro; lint-helpers fuori dai run", async () => {
    as(LAURA);
    const view = (await projectSettings.getProjectPlugins(ACQ))!;
    expect(view.canEdit).toBe(true);
    expect(view.version).toBe(1);
    expect(view.plugins.map((p) => [p.name, p.base, p.status, p.inRuns])).toEqual([
      ["stubwise", true, "ready", true],
      ["superpowers", false, "ready", true],
      ["lint-helpers", false, "failed", false],
    ]);
    const superpowers = view.plugins.find((p) => p.name === "superpowers")!;
    expect(superpowers.skills).toHaveLength(9);
    expect(superpowers.skills.every((s) => s.enabled)).toBe(true);
    expect(superpowers.hooks).toEqual([
      {
        key: "SessionStart#0",
        event: "SessionStart",
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
        enabled: true,
      },
    ]);
    expect(superpowers.preset).toEqual([
      "using-git-worktrees",
      "finishing-a-development-branch",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ]);
    expect(view.plugins.find((p) => p.name === "stubwise")!.preset).toBeNull();
  });

  it("Sara legge senza poter modificare; un progetto invisibile o archiviato è null", async () => {
    as(SARA);
    expect((await projectSettings.getProjectPlugins(ACQ))!.canEdit).toBe(false);
    expect(await projectSettings.getProjectPlugins(AUD)).toBeNull();
    as(ROBERTA);
    expect(await projectSettings.getProjectPlugins(RNC)).toBeNull();
  });

  it("il seme: ZNC ha superpowers tutto spento, AUD solo test-driven-development", async () => {
    as(ROBERTA);
    const znc = (await projectSettings.getProjectPlugins(ZNC))!;
    const sp = znc.plugins.find((p) => p.name === "superpowers")!;
    expect(sp.skills.every((s) => !s.enabled)).toBe(true);
    expect(sp.hooks.every((h) => !h.enabled)).toBe(true);
    const aud = (await projectSettings.getProjectPlugins(AUD))!;
    expect(
      aud.plugins
        .find((p) => p.name === "superpowers")!
        .skills.filter((s) => !s.enabled)
        .map((s) => s.name),
    ).toEqual(["test-driven-development"]);
  });

  it("RECOMMENDED_PRESETS è chiavato sul name del manifest", () => {
    expect(projectSettings.BASE_PLUGIN).toBe("stubwise");
    expect(projectSettings.RECOMMENDED_PRESETS).toEqual({
      superpowers: [
        "using-git-worktrees",
        "finishing-a-development-branch",
        "dispatching-parallel-agents",
        "subagent-driven-development",
      ],
    });
  });
});

describe("skillsForRun e «/»", () => {
  it("le skill dei plugin ready, meno le spente, più il plugin base in coda", () => {
    expect(runSkills(AUD)).toEqual([
      "superpowers:brainstorming",
      "superpowers:writing-plans",
      "superpowers:systematic-debugging",
      "superpowers:verification-before-completion",
      "superpowers:using-git-worktrees",
      "superpowers:finishing-a-development-branch",
      "superpowers:dispatching-parallel-agents",
      "superpowers:subagent-driven-development",
      "stubwise:stubwise",
      "stubwise:init",
      "stubwise:start",
    ]);
    expect(runSkills(ZNC)).toEqual(["stubwise:stubwise", "stubwise:init", "stubwise:start"]);
  });

  it("lint-helpers (failed) non è in skillsForRun, nemmeno se torna con un inventario", () => {
    const lint = state.instance.plugins.find((p) => p.slug === "lint-helpers")!;
    lint.inventory = { skills: [{ name: "fix-lint", description: "Fixes lint." }], hooks: [] };
    expect(runSkills(ACQ).some((s) => s.startsWith("lint-helpers:"))).toBe(false);
    lint.status = "ready";
    expect(runSkills(ACQ)).toContain("lint-helpers:fix-lint");
  });

  it("spegnere superpowers:brainstorming lo toglie da skillsForRun e da listCommands del progetto", async () => {
    as(LAURA);
    expect((await listCommands(ACQ)).map((c) => c.label)).toContain("/superpowers:brainstorming");
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: 1,
        disabled: [{ plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] }],
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(runSkills(ACQ)).not.toContain("superpowers:brainstorming");
    const labels = (await listCommands(ACQ)).map((c) => c.label);
    expect(labels).not.toContain("/superpowers:brainstorming");
    expect(labels).toContain("/superpowers:writing-plans");
    // Il plugin base resta in «/», in coda.
    expect(labels.slice(-3)).toEqual(["/stubwise:stubwise", "/stubwise:init", "/stubwise:start"]);
  });
});

describe("il salvataggio dei plugin", () => {
  it("ruling (T10): una scelta salvata fuori dall'inventario di un plugin ready si scarta salvando, senza invalid", async () => {
    as(LAURA);
    choicesOf(ACQ).disabled.push({
      plugin: "superpowers",
      skills: ["old-skill"],
      hookGroups: ["Stop#9"],
    });
    const view = (await projectSettings.getProjectPlugins(ACQ))!;
    const keys = projectSettings.pluginOffKeys(view);
    keys.add("superpowers:brainstorming");
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: view.version,
        disabled: projectSettings.pluginDisabledInput(view, keys),
      }),
    ).toEqual({ ok: true, version: view.version + 1 });
    expect(choicesOf(ACQ).disabled).toEqual([
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
    ]);
    // Un nome inventato, che non era fra le scelte salvate, resta un invalid.
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: view.version + 1,
        disabled: [{ plugin: "superpowers", skills: ["nope"], hookGroups: [] }],
      }),
    ).toMatchObject({ error: "invalid", reason: "skill" });
  });

  it("RF 5: due letture con version 3, la prima salva (4), la seconda → conflict senza scrivere", async () => {
    choicesOf(ACQ).version = 3;
    as(LAURA);
    const first = (await projectSettings.getProjectPlugins(ACQ))!;
    const second = (await projectSettings.getProjectPlugins(ACQ))!;
    expect([first.version, second.version]).toEqual([3, 3]);
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: first.version,
        disabled: [{ plugin: "superpowers", skills: ["writing-plans"], hookGroups: [] }],
      }),
    ).toEqual({ ok: true, version: 4 });
    const after = JSON.stringify(choicesOf(ACQ));
    const written = entries().length;
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: second.version,
        disabled: [{ plugin: "superpowers", skills: [], hookGroups: ["SessionStart#0"] }],
      }),
    ).toEqual({ ok: false, error: "conflict" });
    expect(JSON.stringify(choicesOf(ACQ))).toBe(after);
    expect(choicesOf(ACQ).disabled).toEqual([
      { plugin: "superpowers", skills: ["writing-plans"], hookGroups: [] },
    ]);
    expect(entries()).toHaveLength(written);
  });

  it("una voce sola, con le skill e i gruppi di hook spenti prima e dopo, chiavi stabili", async () => {
    as(LAURA);
    await projectSettings.saveProjectPlugins(ACQ, {
      version: 1,
      disabled: [
        {
          plugin: "superpowers",
          skills: ["writing-plans", "brainstorming"],
          hookGroups: ["SessionStart#0"],
        },
      ],
    });
    const voices = entries("project.plugins_changed");
    expect(voices).toHaveLength(1);
    expect(entries()).toHaveLength(1);
    expect(JSON.parse(voices[0]!.before!)).toEqual({ disabledSkills: [], disabledHooks: [] });
    expect(JSON.parse(voices[0]!.after!)).toEqual({
      disabledSkills: ["superpowers:brainstorming", "superpowers:writing-plans"],
      disabledHooks: ["superpowers#SessionStart#0"],
    });
    expect(voices[0]!.projectId).toBe(ACQ);
  });

  it("il preset consigliato tocca solo le sue quattro skill", async () => {
    as(LAURA);
    const preset = projectSettings.RECOMMENDED_PRESETS.superpowers!;
    await projectSettings.saveProjectPlugins(ACQ, {
      version: 1,
      disabled: [{ plugin: "superpowers", skills: [...preset], hookGroups: [] }],
    });
    const sp = (await projectSettings.getProjectPlugins(ACQ))!.plugins.find(
      (p) => p.name === "superpowers",
    )!;
    expect(sp.skills.filter((s) => !s.enabled).map((s) => s.name)).toEqual(preset);
    expect(sp.skills.filter((s) => s.enabled)).toHaveLength(5);
    expect(sp.hooks.every((h) => h.enabled)).toBe(true);
  });

  it("[PG 4] le scelte di un plugin non ready restano, si vedono e non si perdono salvando gli altri", async () => {
    as(LAURA);
    // lint-helpers è `failed`, senza inventario: le scelte salvate per lui
    // valgono quando sarà pronto.
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: 1,
        disabled: [{ plugin: "lint-helpers", skills: ["fix-lint"], hookGroups: ["Stop#0"] }],
      }),
    ).toEqual({ ok: true, version: 2 });
    const lint = () =>
      projectSettings
        .getProjectPlugins(ACQ)
        .then((v) => v!.plugins.find((p) => p.name === "lint-helpers")!);
    // La vista le mostra anche senza inventario.
    expect((await lint()).skills).toEqual([{ name: "fix-lint", description: "", enabled: false }]);
    expect((await lint()).hooks).toEqual([
      { key: "Stop#0", event: "Stop", command: "", enabled: false },
    ]);
    seeded = state.changelog.length;
    // Una pagina che non le rimanda (salva solo superpowers) non le cancella.
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: 2,
        disabled: [{ plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] }],
      }),
    ).toEqual({ ok: true, version: 3 });
    expect(choicesOf(ACQ).disabled).toEqual([
      { plugin: "lint-helpers", skills: ["fix-lint"], hookGroups: ["Stop#0"] },
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
    ]);
    // La voce non le dà «riaccese».
    const voice = entries("project.plugins_changed")[0]!;
    expect(JSON.parse(voice.after!).disabledSkills).toContain("lint-helpers:fix-lint");
    expect(JSON.parse(voice.before!).disabledSkills).toContain("lint-helpers:fix-lint");
    // Nominarlo con le liste vuote lo riaccende, quello sì.
    expect(
      await projectSettings.saveProjectPlugins(ACQ, {
        version: 3,
        disabled: [
          { plugin: "lint-helpers", skills: [], hookGroups: [] },
          { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
        ],
      }),
    ).toEqual({ ok: true, version: 4 });
    expect(choicesOf(ACQ).disabled.map((d) => d.plugin)).toEqual(["superpowers"]);
  });

  it("salvare senza cambiare niente non scrive voci né cambia versione", async () => {
    as(LAURA);
    expect(await projectSettings.saveProjectPlugins(ACQ, { version: 1, disabled: [] })).toEqual({
      ok: true,
      version: 1,
    });
    expect(entries()).toHaveLength(0);
  });

  it("i rifiuti: base_plugin, plugin/skill/hook sconosciuti, forbidden, not_found", async () => {
    as(LAURA);
    const save = (disabled: Parameters<typeof projectSettings.saveProjectPlugins>[1]["disabled"]) =>
      projectSettings.saveProjectPlugins(ACQ, { version: 1, disabled });
    expect(await save([{ plugin: "stubwise", skills: ["init"], hookGroups: [] }])).toEqual({
      ok: false,
      error: "invalid",
      reason: "base_plugin",
    });
    expect(await save([{ plugin: "nope", skills: [], hookGroups: [] }])).toMatchObject({
      error: "invalid",
      reason: "plugin",
    });
    expect(await save([{ plugin: "superpowers", skills: ["nope"], hookGroups: [] }])).toMatchObject(
      { error: "invalid", reason: "skill" },
    );
    expect(
      await save([{ plugin: "superpowers", skills: [], hookGroups: ["Stop#3"] }]),
    ).toMatchObject({ error: "invalid", reason: "hook" });
    as(SARA);
    expect(await save([])).toEqual({ ok: false, error: "forbidden" });
    as(ROBERTA);
    expect(await projectSettings.saveProjectPlugins(RNC, { version: 1, disabled: [] })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(choicesOf(ACQ)).toEqual({ version: 1, disabled: [] });
    expect(entries()).toHaveLength(0);
  });
});

describe("la bozza della pagina (Task 10): chiavi stabili, preset, riconciliazione", () => {
  it("le chiavi spente sono quelle dei plugin `ready` del registro; il plugin base e i non pronti no", async () => {
    as(ROBERTA);
    choicesOf(AUD).disabled.push({ plugin: "lint-helpers", skills: ["fix-lint"], hookGroups: [] });
    const view = (await projectSettings.getProjectPlugins(AUD))!;
    expect([...projectSettings.pluginOffKeys(view)]).toEqual([
      "superpowers:test-driven-development",
    ]);
  });

  it("l'input del salvataggio nomina solo i plugin `ready` del registro ([PG 4]), anche quelli tutti accesi", async () => {
    as(LAURA);
    const view = (await projectSettings.getProjectPlugins(ACQ))!;
    expect(
      projectSettings.pluginDisabledInput(
        view,
        new Set(["superpowers:brainstorming", "superpowers#SessionStart#0"]),
      ),
    ).toEqual([
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: ["SessionStart#0"] },
    ]);
    expect(projectSettings.pluginDisabledInput(view, new Set())).toEqual([
      { plugin: "superpowers", skills: [], hookGroups: [] },
    ]);
  });

  it("il preset spegne solo le sue quattro skill, e dice quante ne ha spente davvero", async () => {
    as(LAURA);
    const view = (await projectSettings.getProjectPlugins(ACQ))!;
    const superpowers = view.plugins.find((p) => p.name === "superpowers")!;
    const first = projectSettings.applyPluginPreset(
      superpowers,
      new Set(["superpowers:using-git-worktrees", "superpowers:brainstorming"]),
    );
    expect([...first.keys].sort()).toEqual([
      "superpowers:brainstorming",
      "superpowers:dispatching-parallel-agents",
      "superpowers:finishing-a-development-branch",
      "superpowers:subagent-driven-development",
      "superpowers:using-git-worktrees",
    ]);
    expect(first.turnedOff).toBe(3);
    expect(projectSettings.pluginPresetApplied(superpowers, first.keys)).toBe(true);
    expect(projectSettings.pluginPresetApplied(superpowers, new Set())).toBe(false);
  });

  it("la riconciliazione: sopra le loro solo le mie righe, chiavate sui nomi; le righe di entrambi", () => {
    const start = new Set(["a:x"]);
    const mine = new Set(["a:y"]); // riaccesa x, spenta y
    const theirs = new Set(["a:x", "a:y", "a:z"]); // spente y e z
    const out = projectSettings.reconcilePluginDraft(start, mine, theirs);
    expect([...out.keys].sort()).toEqual(["a:y", "a:z"]);
    expect(out.bothChanged).toEqual(["a:y"]);
  });
});
