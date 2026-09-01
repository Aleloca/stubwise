import { pluginInventorySchema } from "@stubwise/shared";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { InvalidPluginManifestError, readInventory } from "./inventory.js";

/**
 * Test del parser dell'inventario su FILE VERI: le fixture in `__fixtures__/`
 * sono plugin veri e propri (manifest, skill, comandi, hook), non oggetti
 * costruiti in memoria — il parser legge codice di terze parti e deve essere
 * verificato su ciò che troverà su disco.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Directory temporanea per le anomalie che non vale la pena committare. */
async function makeTmpPlugin(name: string, manifest?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `stubwise-plugin-${name}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  if (manifest !== undefined) {
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), manifest, "utf8");
  }
  return dir;
}

describe("readInventory — plugin completo", () => {
  it("legge manifest, skill, comandi, agenti, hook e .mcp.json", async () => {
    const dir = join(fixturesDir, "plugin-a");

    const inventory = await readInventory(dir);

    expect(inventory).toEqual({
      name: "plugin-a",
      version: "1.2.3",
      description: "Plugin di prova con due skill, un comando, un agente e un hook.",
      skills: [
        {
          // Il `name` del frontmatter vince sul nome della directory.
          name: "alpha-skill",
          description:
            "Use when you need the alpha behaviour - the frontmatter name wins over the directory name.",
          bytes: statSync(join(dir, "skills", "alpha", "SKILL.md")).size,
        },
        {
          // Nessun frontmatter: il nome degrada a quello della directory.
          name: "beta",
          bytes: statSync(join(dir, "skills", "beta", "SKILL.md")).size,
        },
      ],
      commands: [{ name: "fai-cosa" }],
      agents: [{ name: "revisore" }],
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
  });

  it("produce un inventario valido per lo schema condiviso", async () => {
    const inventory = await readInventory(join(fixturesDir, "plugin-a"));

    // Il valore finisce in una colonna jsonb letta da server e SPA: deve
    // rispettare il contratto di @stubwise/shared, non solo "assomigliarci".
    expect(pluginInventorySchema.safeParse(inventory).success).toBe(true);
  });
});

describe("readInventory — anomalie", () => {
  it("degrada su manifest anomalo, skill senza frontmatter e hooks.json rotto", async () => {
    const dir = join(fixturesDir, "plugin-weird");

    const inventory = await readInventory(dir);

    expect(inventory.name).toBe("plugin-weird");
    // `version: 42` non è una stringa: ignorata invece di far fallire il parse.
    expect(inventory.version).toBeUndefined();
    // Descrizione oltre il cap dello schema: troncata, non rifiutata.
    expect(inventory.description).toHaveLength(2000);
    expect(inventory.skills.map((s) => s.name)).toEqual(["nome-vuoto", "senza-frontmatter"]);
    // Frontmatter con `name` vuoto: vale comunque il nome della directory.
    expect(inventory.skills[0]!.description).toBe(
      "Descrizione scritta come block scalar su piu righe, che il parser minimale deve unire in una riga sola.",
    );
    expect(inventory.skills[1]!.description).toBeUndefined();
    // `hooks.json` non parsabile: nessun hook elencato, ma l'inventario esiste.
    expect(inventory.hooks).toEqual([]);
    // Directory assenti: liste vuote, non errori.
    expect(inventory.commands).toEqual([]);
    expect(inventory.agents).toEqual([]);
    expect(inventory.hasMcp).toBe(false);
    expect(pluginInventorySchema.safeParse(inventory).success).toBe(true);
  });

  it("appiattisce i gruppi di hook conservando l'indice del gruppo", async () => {
    const inventory = await readInventory(join(fixturesDir, "plugin-hooks"));

    expect(inventory.hooks).toEqual([
      {
        key: "SessionStart#0",
        event: "SessionStart",
        matcher: "startup",
        command: "echo uno",
      },
      {
        // Più comandi nello stesso gruppo: un'unica voce (la chiave spegne il
        // gruppo intero). Le entry con `type` diverso da "command" sono escluse.
        key: "SessionStart#1",
        event: "SessionStart",
        command: "echo due-a\necho due-b",
      },
      {
        // `SessionStart#2` non ha comandi ed è saltato: l'indice NON viene
        // rinumerato, o la chiave non corrisponderebbe più al gruppo.
        key: "SessionStart#3",
        event: "SessionStart",
        matcher: "compact",
        command: "echo quattro",
      },
      // Un evento sconosciuto va elencato (e quindi spegnibile), non scartato.
      { key: "EventoSconosciuto#0", event: "EventoSconosciuto", command: "echo ignoto" },
    ]);
    expect(pluginInventorySchema.safeParse(inventory).success).toBe(true);
  });

  it("rifiuta un plugin senza manifest", async () => {
    const dir = await makeTmpPlugin("no-manifest");

    await expect(readInventory(dir)).rejects.toThrow(InvalidPluginManifestError);
  });

  it("rifiuta un manifest non parsabile o senza name", async () => {
    const rotto = await makeTmpPlugin("rotto", "{ non json");
    const senzaNome = await makeTmpPlugin("senza-nome", JSON.stringify({ version: "1.0.0" }));

    await expect(readInventory(rotto)).rejects.toThrow(InvalidPluginManifestError);
    await expect(readInventory(senzaNome)).rejects.toThrow(InvalidPluginManifestError);
  });

  it("ignora skills/, commands/ e agents/ se non sono directory", async () => {
    const dir = await makeTmpPlugin("file-al-posto-di-dir", JSON.stringify({ name: "strano" }));
    await writeFile(join(dir, "skills"), "non sono una directory", "utf8");
    await writeFile(join(dir, "commands"), "nemmeno io", "utf8");

    const inventory = await readInventory(dir);

    expect(inventory).toEqual({
      name: "strano",
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      hasMcp: false,
    });
  });

  it("elenca una skill il cui SKILL.md non è leggibile", async () => {
    const dir = await makeTmpPlugin("skill-illeggibile", JSON.stringify({ name: "strano" }));
    // SKILL.md come DIRECTORY: la lettura fallisce con EISDIR. La skill esiste
    // comunque per il CLI, quindi va elencata (l'admin deve poterla spegnere).
    await mkdir(join(dir, "skills", "rotta", "SKILL.md"), { recursive: true });
    // Una sottodirectory di skills/ senza SKILL.md non è una skill.
    await mkdir(join(dir, "skills", "non-una-skill"), { recursive: true });

    const inventory = await readInventory(dir);

    expect(inventory.skills).toEqual([{ name: "rotta", bytes: 0 }]);
  });

  it("non segue un SKILL.md symlinkato fuori dal plugin", async () => {
    const dir = await makeTmpPlugin("skill-symlink", JSON.stringify({ name: "strano" }));
    const esterno = join(dir, "segreto-dell-host.md");
    await writeFile(esterno, "---\nname: segreto\ndescription: roba dell host\n---\n", "utf8");
    await mkdir(join(dir, "skills", "esfiltrante"), { recursive: true });
    await symlink(esterno, join(dir, "skills", "esfiltrante", "SKILL.md"));

    const inventory = await readInventory(dir);

    // La skill è elencata (esiste, va resa spegnibile) ma il link NON è stato
    // seguito: niente nome/descrizione/dimensione presi dal file esterno.
    expect(inventory.skills).toEqual([{ name: "esfiltrante", bytes: 0 }]);
  });

  it("non segue un plugin.json symlinkato", async () => {
    const dir = await makeTmpPlugin("manifest-symlink");
    const esterno = join(dir, "altrove.json");
    await writeFile(esterno, JSON.stringify({ name: "preso-dall-host" }), "utf8");
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await symlink(esterno, join(dir, ".claude-plugin", "plugin.json"));

    // Manifest symlinkato = manifest assente: è l'unico errore fatale del
    // parser, quindi il plugin non viene materializzato con un nome altrui.
    await expect(readInventory(dir)).rejects.toThrow(InvalidPluginManifestError);
  });

  it("non segue un hooks/hooks.json symlinkato", async () => {
    const dir = await makeTmpPlugin("hooks-symlink", JSON.stringify({ name: "strano" }));
    const esterno = join(dir, "altrove.json");
    await writeFile(
      esterno,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } }),
      "utf8",
    );
    await mkdir(join(dir, "hooks"), { recursive: true });
    await symlink(esterno, join(dir, "hooks", "hooks.json"));

    const inventory = await readInventory(dir);

    // Symlink trattato come file assente: nessun hook letto da fuori.
    expect(inventory.hooks).toEqual([]);
  });

  it("tronca i campi che superano i limiti dello schema", async () => {
    const dir = await makeTmpPlugin("lunghissimo", JSON.stringify({ name: "x".repeat(500) }));
    await mkdir(join(dir, "skills", "s"), { recursive: true });
    await writeFile(
      join(dir, "skills", "s", "SKILL.md"),
      `---\nname: ${"n".repeat(400)}\ndescription: ${"d".repeat(3000)}\n---\n`,
      "utf8",
    );

    const inventory = await readInventory(dir);

    expect(inventory.name).toHaveLength(200);
    expect(inventory.skills[0]!.name).toHaveLength(200);
    expect(inventory.skills[0]!.description).toHaveLength(2000);
    expect(pluginInventorySchema.safeParse(inventory).success).toBe(true);
  });
});
