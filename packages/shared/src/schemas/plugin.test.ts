import { describe, expect, it } from "vitest";
import {
  createPluginSchema,
  pluginInventorySchema,
  pluginSchema,
  projectPluginSchema,
  putProjectPluginsSchema,
  updatePluginRefSchema,
} from "./plugin.js";

describe("pluginInventorySchema", () => {
  const minimal = {
    name: "superpowers",
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    hasMcp: false,
  };

  it("accetta un inventario minimo (solo il nome, liste vuote)", () => {
    const parsed = pluginInventorySchema.parse(minimal);
    expect(parsed.name).toBe("superpowers");
    expect(parsed.version).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.skills).toEqual([]);
    expect(parsed.hasMcp).toBe(false);
  });

  it("accetta un inventario completo", () => {
    const parsed = pluginInventorySchema.parse({
      name: "superpowers",
      version: "4.0.3",
      description: "Skill di metodo",
      skills: [
        { name: "writing-plans", description: "Piani", bytes: 4096 },
        { name: "using-git-worktrees", bytes: 2048 },
      ],
      commands: [{ name: "brainstorm" }],
      agents: [{ name: "code-reviewer" }],
      hooks: [
        {
          key: "SessionStart#0",
          event: "SessionStart",
          matcher: "startup|resume",
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
        },
      ],
      hasMcp: true,
    });
    expect(parsed.skills[1]?.description).toBeUndefined();
    expect(parsed.hooks[0]?.key).toBe("SessionStart#0");
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.agents[0]?.name).toBe("code-reviewer");
  });

  it("rifiuta un inventario senza nome o con liste mancanti", () => {
    expect(() => pluginInventorySchema.parse({ ...minimal, name: "" })).toThrow();
    expect(() => pluginInventorySchema.parse({ ...minimal, skills: undefined })).toThrow();
    expect(() => pluginInventorySchema.parse({ ...minimal, hasMcp: undefined })).toThrow();
  });

  it("rifiuta una skill senza dimensione o con dimensione non intera", () => {
    expect(() =>
      pluginInventorySchema.parse({ ...minimal, skills: [{ name: "x" }] }),
    ).toThrow();
    expect(() =>
      pluginInventorySchema.parse({ ...minimal, skills: [{ name: "x", bytes: 1.5 }] }),
    ).toThrow();
    expect(() =>
      pluginInventorySchema.parse({ ...minimal, skills: [{ name: "x", bytes: -1 }] }),
    ).toThrow();
  });

  it("rifiuta un hook senza comando, senza chiave o senza evento", () => {
    expect(() =>
      pluginInventorySchema.parse({
        ...minimal,
        hooks: [{ key: "SessionStart#0", event: "SessionStart" }],
      }),
    ).toThrow();
    expect(() =>
      pluginInventorySchema.parse({
        ...minimal,
        hooks: [{ event: "SessionStart", command: "./x.sh" }],
      }),
    ).toThrow();
    expect(() =>
      pluginInventorySchema.parse({
        ...minimal,
        hooks: [{ key: "SessionStart#0", command: "./x.sh" }],
      }),
    ).toThrow();
    expect(() =>
      pluginInventorySchema.parse({
        ...minimal,
        hooks: [{ key: "SessionStart#0", event: "", command: "./x.sh" }],
      }),
    ).toThrow();
  });
});

describe("createPluginSchema", () => {
  it("accetta un URL https pubblico con ref e senza subdir", () => {
    const parsed = createPluginSchema.parse({
      sourceUrl: "https://github.com/obra/superpowers.git",
      ref: "v4.0.3",
    });
    expect(parsed.sourceUrl).toBe("https://github.com/obra/superpowers.git");
    expect(parsed.sourceSubdir).toBeUndefined();
  });

  it("rifiuta gli URL non https (http, ssh, git, file)", () => {
    for (const sourceUrl of [
      "http://github.com/obra/superpowers.git",
      "git@github.com:obra/superpowers.git",
      "ssh://git@github.com/obra/superpowers.git",
      "git://github.com/obra/superpowers.git",
      "file:///tmp/plugin",
      "non-un-url",
    ]) {
      expect(() => createPluginSchema.parse({ sourceUrl, ref: "main" })).toThrow();
    }
  });

  it("rifiuta un URL con credenziali", () => {
    expect(() =>
      createPluginSchema.parse({
        sourceUrl: "https://utente:token@github.com/obra/superpowers.git",
        ref: "main",
      }),
    ).toThrow();
    expect(() =>
      createPluginSchema.parse({
        sourceUrl: "https://token@github.com/obra/superpowers.git",
        ref: "main",
      }),
    ).toThrow();
  });

  it("rifiuta una subdir che esce dalla directory o assoluta", () => {
    for (const sourceSubdir of [
      "..",
      "../fuori",
      "plugins/../../fuori",
      "/assoluta",
      "plugins/",
      "",
      "./plugins",
      "plugins//annidato",
      // Il backslash non spezza i segmenti: rifiutato in blocco (fail-closed).
      "plugins\\..\\fuori",
      "plugins\\superpowers",
    ]) {
      expect(() =>
        createPluginSchema.parse({
          sourceUrl: "https://github.com/obra/superpowers.git",
          ref: "main",
          sourceSubdir,
        }),
      ).toThrow();
    }
  });

  it("accetta una subdir relativa normalizzata", () => {
    const parsed = createPluginSchema.parse({
      sourceUrl: "https://github.com/obra/monorepo.git",
      ref: "main",
      sourceSubdir: "plugins/superpowers",
    });
    expect(parsed.sourceSubdir).toBe("plugins/superpowers");
  });

  it("rifiuta un ref vuoto o troppo lungo", () => {
    const sourceUrl = "https://github.com/obra/superpowers.git";
    expect(() => createPluginSchema.parse({ sourceUrl, ref: "" })).toThrow();
    expect(() => createPluginSchema.parse({ sourceUrl, ref: "a".repeat(201) })).toThrow();
    expect(createPluginSchema.parse({ sourceUrl, ref: "a".repeat(200) }).ref).toHaveLength(200);
  });

  it("rifiuta un sourceUrl oltre i 2000 caratteri", () => {
    const prefisso = "https://github.com/obra/";
    const alLimite = `${prefisso}${"a".repeat(2000 - prefisso.length)}`;
    expect(createPluginSchema.parse({ sourceUrl: alLimite, ref: "main" }).sourceUrl).toHaveLength(
      2000,
    );
    expect(() => createPluginSchema.parse({ sourceUrl: `${alLimite}a`, ref: "main" })).toThrow();
  });
});

describe("updatePluginRefSchema", () => {
  it("accetta il solo ref", () => {
    expect(updatePluginRefSchema.parse({ ref: "v4.1.0" }).ref).toBe("v4.1.0");
  });

  it("rifiuta un ref mancante o vuoto", () => {
    expect(() => updatePluginRefSchema.parse({})).toThrow();
    expect(() => updatePluginRefSchema.parse({ ref: "" })).toThrow();
  });
});

describe("pluginSchema", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "superpowers",
    name: "superpowers",
    sourceUrl: "https://github.com/obra/superpowers.git",
    sourceSubdir: null,
    ref: "v4.0.3",
    resolvedSha: null,
    status: "none",
    inventory: null,
    error: null,
    smokeStatus: "idle",
    smokeError: null,
    materializedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };

  it("accetta un plugin appena registrato (nessuna materializzazione)", () => {
    const parsed = pluginSchema.parse(base);
    expect(parsed.status).toBe("none");
    expect(parsed.inventory).toBeNull();
  });

  it("accetta un plugin pronto con inventario e sha risolto", () => {
    const parsed = pluginSchema.parse({
      ...base,
      status: "ready",
      resolvedSha: "a".repeat(40),
      smokeStatus: "passed",
      materializedAt: "2026-09-01T10:05:00.000Z",
      inventory: {
        name: "superpowers",
        skills: [{ name: "writing-plans", bytes: 10 }],
        commands: [],
        agents: [],
        hooks: [],
        hasMcp: false,
      },
    });
    expect(parsed.inventory?.skills[0]?.name).toBe("writing-plans");
    expect(parsed.materializedAt).toBe("2026-09-01T10:05:00.000Z");
  });

  it("rifiuta stati sconosciuti e date non ISO", () => {
    expect(() => pluginSchema.parse({ ...base, status: "pending" })).toThrow();
    expect(() => pluginSchema.parse({ ...base, smokeStatus: "ok" })).toThrow();
    expect(() => pluginSchema.parse({ ...base, createdAt: "2026-09-01" })).toThrow();
  });
});

describe("projectPluginSchema / putProjectPluginsSchema", () => {
  const pluginId = "22222222-2222-4222-8222-222222222222";

  it("applica i default alle liste di disabilitazione", () => {
    const parsed = projectPluginSchema.parse({ pluginId, enabled: true });
    expect(parsed.disabledSkills).toEqual([]);
    expect(parsed.disabledHooks).toEqual([]);
  });

  it("accetta skill e hook spenti", () => {
    const parsed = projectPluginSchema.parse({
      pluginId,
      enabled: true,
      disabledSkills: ["using-git-worktrees"],
      disabledHooks: ["SessionStart#0"],
    });
    expect(parsed.disabledSkills).toEqual(["using-git-worktrees"]);
    expect(parsed.disabledHooks).toEqual(["SessionStart#0"]);
  });

  it("rifiuta un pluginId non uuid o voci vuote", () => {
    expect(() => projectPluginSchema.parse({ pluginId: "abc", enabled: true })).toThrow();
    expect(() =>
      projectPluginSchema.parse({ pluginId, enabled: true, disabledSkills: [""] }),
    ).toThrow();
    expect(() =>
      projectPluginSchema.parse({ pluginId, enabled: true, disabledHooks: [""] }),
    ).toThrow();
  });

  it("accetta l'insieme completo delle abilitazioni, vuoto incluso", () => {
    expect(putProjectPluginsSchema.parse({ plugins: [] }).plugins).toEqual([]);
    const parsed = putProjectPluginsSchema.parse({
      plugins: [{ pluginId, enabled: false }],
    });
    expect(parsed.plugins[0]?.enabled).toBe(false);
  });

  it("rifiuta un pluginId ripetuto nell'insieme (body ambiguo)", () => {
    expect(() =>
      putProjectPluginsSchema.parse({
        plugins: [
          { pluginId, enabled: true },
          { pluginId, enabled: false },
        ],
      }),
    ).toThrow();
    // Due plugin distinti restano validi.
    const altro = "33333333-3333-4333-8333-333333333333";
    expect(
      putProjectPluginsSchema.parse({
        plugins: [
          { pluginId, enabled: true },
          { pluginId: altro, enabled: true },
        ],
      }).plugins,
    ).toHaveLength(2);
  });

  it("limita le liste di disabilitazione a 500 voci", () => {
    const skills = Array.from({ length: 500 }, (_, i) => `skill-${i}`);
    expect(
      projectPluginSchema.parse({ pluginId, enabled: true, disabledSkills: skills }).disabledSkills,
    ).toHaveLength(500);
    expect(() =>
      projectPluginSchema.parse({ pluginId, enabled: true, disabledSkills: [...skills, "extra"] }),
    ).toThrow();
    expect(() =>
      projectPluginSchema.parse({
        pluginId,
        enabled: true,
        disabledHooks: [...skills, "extra"].map((s) => `Event#${s}`),
      }),
    ).toThrow();
  });

  it("limita l'insieme a 200 plugin", () => {
    // Uuid distinti generati dall'indice: il cap deve scattare sulla lunghezza,
    // non sul controllo dei duplicati.
    const idAt = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const plugins = Array.from({ length: 200 }, (_, i) => ({ pluginId: idAt(i), enabled: true }));
    expect(putProjectPluginsSchema.parse({ plugins }).plugins).toHaveLength(200);
    expect(() =>
      putProjectPluginsSchema.parse({
        plugins: [...plugins, { pluginId: idAt(200), enabled: true }],
      }),
    ).toThrow();
  });

  it("rifiuta un PUT senza la lista (full-replacement esplicito)", () => {
    // Nessun default sul body: omettere `plugins` è un errore, non un
    // azzeramento silenzioso delle abilitazioni del progetto.
    expect(() => putProjectPluginsSchema.parse({})).toThrow();
  });
});
