import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPluginSchema,
  pluginInventorySchema,
  pluginRecommendationsSchema,
  pluginSchema,
  pluginSlugSchema,
  projectPluginSchema,
  putProjectPluginsSchema,
  RECOMMENDED_DISABLED_SKILLS,
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
    ]) {
      // safeParse invece di parse+toThrow: un'eccezione NON-Zod (es. un
      // TypeError sfuggito da un refine) farebbe fallire il test invece di
      // passare per verde. Vale per tutti i casi di rifiuto di sourceUrl.
      expect(createPluginSchema.safeParse({ sourceUrl, ref: "main" }).success).toBe(false);
    }
  });

  it("rifiuta gli URL non parsabili senza lanciare fuori da Zod", () => {
    // REGRESSIONE: in Zod v4 un check di formato fallito (`z.url()`) NON
    // interrompe la catena, quindi il refine successivo gira comunque sulla
    // stringa grezza. Se `new URL()` non fosse protetto, qui uscirebbe un
    // TypeError e la rotta di creazione risponderebbe 500 invece di 400.
    for (const sourceUrl of ["non-un-url", "https://", "https://%", "", "   "]) {
      const esito = createPluginSchema.safeParse({ sourceUrl, ref: "main" });
      expect(esito.success).toBe(false);
      expect(esito.error).toBeInstanceOf(z.ZodError);
    }
  });

  it("rifiuta un URL con credenziali", () => {
    expect(
      createPluginSchema.safeParse({
        sourceUrl: "https://utente:token@github.com/obra/superpowers.git",
        ref: "main",
      }).success,
    ).toBe(false);
    expect(
      createPluginSchema.safeParse({
        sourceUrl: "https://token@github.com/obra/superpowers.git",
        ref: "main",
      }).success,
    ).toBe(false);
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
      expect(
        createPluginSchema.safeParse({
          sourceUrl: "https://github.com/obra/superpowers.git",
          ref: "main",
          sourceSubdir,
        }).success,
      ).toBe(false);
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
    expect(
      createPluginSchema.safeParse({ sourceUrl: `${alLimite}a`, ref: "main" }).success,
    ).toBe(false);
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
    pendingJobKind: null,
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

  it("rifiuta voci malformate senza lanciare fuori da Zod", () => {
    // Oggi Zod NON esegue il refine dei duplicati quando gli elementi dell'array
    // hanno fallito il parse (a differenza dei check sulla stessa stringa, dove
    // la catena prosegue: vedi sourceUrl). È però un dettaglio di implementazione:
    // questo test blinda che un upgrade non trasformi mai un body malformato in
    // un'eccezione fuori da Zod.
    for (const plugins of [[null], [undefined], [3], ["x"], [{}], [[]], [{ pluginId: "abc" }]]) {
      const esito = putProjectPluginsSchema.safeParse({ plugins });
      expect(esito.success).toBe(false);
      expect(esito.error).toBeInstanceOf(z.ZodError);
    }
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

describe("pluginSlugSchema", () => {
  it("accetta gli slug ammessi", () => {
    // `trailing-` passa: un trattino finale non è un problema di sicurezza (il
    // normalizzatore del server lo toglie comunque), e stringere qui il pattern
    // oltre il necessario non aggiungerebbe nulla.
    for (const slug of ["superpowers", "a", "stubwise-base", "x9", "trailing-", "a".repeat(64)]) {
      expect(pluginSlugSchema.parse(slug)).toBe(slug);
    }
  });

  it("rifiuta tutto ciò che non è un singolo segmento di path innocuo", () => {
    // Lo slug è un COMPONENTE DI PERCORSO su `<PLUGINS_DIR>/<slug>/<sha>`: ogni
    // riga qui sotto è un modo di uscire da quella directory o di confondere
    // chi la compone.
    for (const slug of [
      "",
      ".",
      "..",
      "../evil",
      "a/b",
      "a\\b",
      "a b",
      ".hidden",
      "-leading",
      "MAIUSCOLE",
      "acc£nti",
      "punto.punto",
      "a".repeat(65),
    ]) {
      expect(() => pluginSlugSchema.parse(slug)).toThrow();
    }
  });

  it("vincola anche la proiezione pubblica del plugin", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000000",
      name: "superpowers",
      sourceUrl: "https://github.com/obra/superpowers",
      sourceSubdir: null,
      ref: "v4.0.3",
      resolvedSha: null,
      status: "none",
      inventory: null,
      error: null,
      smokeStatus: "idle",
      smokeError: null,
      pendingJobKind: "materialize",
      materializedAt: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    };
    expect(pluginSchema.parse({ ...base, slug: "superpowers" }).slug).toBe("superpowers");
    expect(() => pluginSchema.parse({ ...base, slug: "../evil" })).toThrow();
  });

  it("ammette `pendingJobKind` null o uno dei due kind, e nient'altro", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000000",
      slug: "superpowers",
      name: "superpowers",
      sourceUrl: "https://github.com/obra/superpowers",
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
    for (const pendingJobKind of [null, "materialize", "smoke"]) {
      expect(pluginSchema.parse({ ...base, pendingJobKind }).pendingJobKind).toBe(pendingJobKind);
    }
    // Campo obbligatorio: ometterlo è un errore, non un `null` implicito — la UI
    // deve poterlo leggere sempre.
    expect(() => pluginSchema.parse(base)).toThrow();
    expect(() => pluginSchema.parse({ ...base, pendingJobKind: "cleanup" })).toThrow();
  });
});

describe("RECOMMENDED_DISABLED_SKILLS", () => {
  it("spegne le quattro skill di superpowers che confliggono col contratto della run", () => {
    expect(RECOMMENDED_DISABLED_SKILLS.superpowers).toEqual([
      "using-git-worktrees",
      "finishing-a-development-branch",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ]);
  });

  it("è validabile dallo schema con cui viaggia nell'API", () => {
    expect(pluginRecommendationsSchema.parse(RECOMMENDED_DISABLED_SKILLS)).toEqual(
      RECOMMENDED_DISABLED_SKILLS,
    );
  });
});
