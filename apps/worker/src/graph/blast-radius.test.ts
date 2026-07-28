import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeBlastRadius,
  parseChangedFiles,
  renderBlastRadiusPromptBlock,
  renderBlastRadiusSection,
  type BlastRadius,
} from "./blast-radius.js";

/** Nodo della fixture: stessi campi del graph.json reale (node-link NetworkX). */
interface FixtureNode {
  id: string;
  label: string;
  source_file: string;
  community: number;
  community_name: string;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "blast-radius-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fixtureSeq = 0;

/** Scrive un graph.json node-link nella tmp dir e ne ritorna il path. */
async function writeGraph(
  nodes: FixtureNode[],
  links: { source: string; target: string }[],
): Promise<string> {
  const path = join(dir, `graph-${fixtureSeq++}.json`);
  await writeFile(
    path,
    JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes, links }),
  );
  return path;
}

/**
 * Grafo di riferimento dei test: 3 comunità e un god node evidente.
 *  - "Core": `buildApp()` in src/app.ts, collegato a TUTTE le 12 route
 *    (grado 12 ⇒ sopra il pavimento di 10 dei god node);
 *  - "Routes": 12 simboli, uno per file, grado 1 ciascuno;
 *  - "Utils": 2 simboli nello STESSO file, collegati fra loro (grado 1).
 */
async function writeStarGraph(): Promise<string> {
  const nodes: FixtureNode[] = [
    {
      id: "hub",
      label: "buildApp()",
      source_file: "src/app.ts",
      community: 1,
      community_name: "Core",
    },
  ];
  const links: { source: string; target: string }[] = [];
  for (let i = 1; i <= 12; i++) {
    nodes.push({
      id: `leaf${i}`,
      label: `route${i}()`,
      source_file: `src/routes/route${i}.ts`,
      community: 2,
      community_name: "Routes",
    });
    links.push({ source: "hub", target: `leaf${i}` });
  }
  nodes.push(
    {
      id: "u1",
      label: "slugify()",
      source_file: "src/utils/slug.ts",
      community: 3,
      community_name: "Utils",
    },
    {
      id: "u2",
      label: "titleCase()",
      source_file: "src/utils/slug.ts",
      community: 3,
      community_name: "Utils",
    },
  );
  links.push({ source: "u1", target: "u2" });
  return writeGraph(nodes, links);
}

describe("parseChangedFiles", () => {
  it("estrae i path dalle righe diff --git (modifica semplice)", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/utils/slug.ts b/src/utils/slug.ts",
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/app.ts", "src/utils/slug.ts"]);
  });

  it("rename: entrambi i lati (il grafo conosce il path VECCHIO)", () => {
    const diff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 98%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/old-name.ts", "src/new-name.ts"]);
  });

  it("delete e add: un solo path (i due lati coincidono)", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/gone.ts", "src/new.ts"]);
  });

  it("path con spazi", () => {
    const diff = "diff --git a/src/my file.ts b/src/my file.ts\n@@ -1 +1 @@\n+x";
    expect(parseChangedFiles(diff)).toEqual(["src/my file.ts"]);
  });

  it("rename di un path con spazi: split sul separatore giusto", () => {
    const diff = "diff --git a/src/old file.ts b/src/new file.ts\nrename from src/old file.ts";
    expect(parseChangedFiles(diff)).toEqual(["src/old file.ts", "src/new file.ts"]);
  });

  it("path quotati (caratteri non ASCII): virgolette rimosse", () => {
    const diff = 'diff --git "a/src/città.ts" "b/src/città.ts"\n@@ -1 +1 @@';
    expect(parseChangedFiles(diff)).toEqual(["src/città.ts"]);
  });

  it("righe di contenuto che imitano l'header non contano (solo inizio riga)", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "@@ -1 +1 @@",
      "+diff --git a/fake.ts b/fake.ts",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/app.ts"]);
  });

  it("diff vuoto o senza header → nessun file", () => {
    expect(parseChangedFiles("")).toEqual([]);
    expect(parseChangedFiles("solo testo\n+ righe")).toEqual([]);
  });

  it("duplicati deduplicati mantenendo l'ordine", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "diff --git a/src/app.ts b/src/app.ts",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/app.ts"]);
  });
});

describe("computeBlastRadius", () => {
  it("aggrega comunità, god node e file dentro/fuori dal grafo", async () => {
    const path = await writeStarGraph();
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["src/app.ts", "src/utils/slug.ts", "README.md"],
    });
    expect(radius).not.toBeNull();
    expect(radius!.filesInGraph).toBe(2);
    expect(radius!.filesNotInGraph).toBe(1);
    expect(radius!.nodesTouched).toBe(3);
    // Utils prima di Core: più simboli toccati.
    expect(radius!.communities).toEqual([
      { name: "Utils", filesTouched: 1, nodesTouched: 2 },
      { name: "Core", filesTouched: 1, nodesTouched: 1 },
    ]);
    expect(radius!.godNodes).toEqual([{ label: "buildApp()", degree: 12 }]);
  });

  it("nessun file del diff nel grafo → risultato vuoto (non null)", async () => {
    const path = await writeStarGraph();
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["README.md", "docs/x.md"],
    });
    expect(radius).not.toBeNull();
    expect(radius!.nodesTouched).toBe(0);
    expect(radius!.communities).toEqual([]);
    expect(radius!.godNodes).toEqual([]);
    expect(radius!.filesInGraph).toBe(0);
    expect(radius!.filesNotInGraph).toBe(2);
  });

  it("normalizza i path con ./ iniziale su entrambi i lati", async () => {
    const path = await writeGraph(
      [
        {
          id: "n1",
          label: "f()",
          source_file: "./src/app.ts",
          community: 1,
          community_name: "Core",
        },
      ],
      [],
    );
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["./src/app.ts"],
    });
    expect(radius!.nodesTouched).toBe(1);
    expect(radius!.filesInGraph).toBe(1);
  });

  it("soglia dei god node: il p95 del grafo vince sul pavimento di 10", async () => {
    // 21 nodi, di cui 20 in cricca completa (gradi 19-20) e uno, n0, di grado
    // esattamente 10. Il p95 vale 20, quindi n0 NON è un god node — se la
    // soglia fosse solo il pavimento di 10, lo sarebbe.
    const nodes: FixtureNode[] = [];
    const links: { source: string; target: string }[] = [];
    for (let i = 0; i < 21; i++) {
      nodes.push({
        id: `n${i}`,
        label: `sym${i}()`,
        source_file: `src/f${i}.ts`,
        community: 1,
        community_name: "Core",
      });
    }
    // n0 ha grado 10 (10 archi verso n1..n10); gli altri ne accumulano molti
    // di più collegandosi a tutti i successivi.
    for (let i = 1; i <= 10; i++) links.push({ source: "n0", target: `n${i}` });
    for (let i = 1; i < 21; i++) {
      for (let j = i + 1; j < 21; j++) links.push({ source: `n${i}`, target: `n${j}` });
    }
    const path = await writeGraph(nodes, links);
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["src/f0.ts"],
    });
    expect(radius!.nodesTouched).toBe(1);
    expect(radius!.godNodes).toEqual([]);
  });

  it("caps: comunità e god node troncati", async () => {
    const nodes: FixtureNode[] = [];
    const links: { source: string; target: string }[] = [];
    // 4 comunità, ognuna con un hub di grado 12+ (tutti god node).
    for (let c = 1; c <= 4; c++) {
      nodes.push({
        id: `hub${c}`,
        label: `hub${c}()`,
        source_file: `src/c${c}/main.ts`,
        community: c,
        community_name: `Community ${c}`,
      });
      for (let i = 0; i < 12 + c; i++) {
        nodes.push({
          id: `leaf${c}_${i}`,
          label: `leaf${c}_${i}()`,
          source_file: `src/c${c}/leaf${i}.ts`,
          community: c,
          community_name: `Community ${c}`,
        });
        links.push({ source: `hub${c}`, target: `leaf${c}_${i}` });
      }
    }
    const path = await writeGraph(nodes, links);
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: [1, 2, 3, 4].map((c) => `src/c${c}/main.ts`),
      caps: { maxCommunities: 2, maxGodNodes: 3 },
    });
    expect(radius!.communities).toHaveLength(2);
    expect(radius!.godNodes).toHaveLength(3);
    // Ordinamento per grado decrescente: l'hub della comunità 4 è il più grosso.
    expect(radius!.godNodes[0]).toEqual({ label: "hub4()", degree: 16 });
  });

  it("fail-open: file assente, JSON corrotto, forma inattesa → null", async () => {
    expect(
      await computeBlastRadius({
        graphJsonPath: join(dir, "non-esiste.json"),
        changedFiles: ["src/app.ts"],
      }),
    ).toBeNull();

    const broken = join(dir, "broken.json");
    await writeFile(broken, '{"nodes": [ {"id": "a"');
    expect(
      await computeBlastRadius({ graphJsonPath: broken, changedFiles: ["src/app.ts"] }),
    ).toBeNull();

    const wrongShape = join(dir, "wrong-shape.json");
    await writeFile(wrongShape, '{"nodes": "non è un array"}');
    expect(
      await computeBlastRadius({ graphJsonPath: wrongShape, changedFiles: ["src/app.ts"] }),
    ).toBeNull();

    const empty = join(dir, "empty.json");
    await writeFile(empty, '{"nodes": [], "links": []}');
    expect(
      await computeBlastRadius({ graphJsonPath: empty, changedFiles: ["src/app.ts"] }),
    ).toBeNull();
  });

  it("nessun file cambiato → null (niente da dire)", async () => {
    const path = await writeStarGraph();
    expect(await computeBlastRadius({ graphJsonPath: path, changedFiles: [] })).toBeNull();
  });

  it("nodi e archi malformati vengono ignorati senza lanciare", async () => {
    const path = await writeGraph(
      [
        // Nodo valido.
        {
          id: "ok",
          label: "ok()",
          source_file: "src/app.ts",
          community: 1,
          community_name: "Core",
        },
        // Nodi rotti (source_file mancante, label non stringa, nodo non oggetto).
        { id: "no-file", label: "x()", community: 1, community_name: "Core" },
        { id: "weird", label: 42, source_file: "src/app.ts", community: 1 },
        null,
      ] as unknown as FixtureNode[],
      [{ source: "ok" }, { target: "ok" }, null] as unknown as {
        source: string;
        target: string;
      }[],
    );
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["src/app.ts"],
    });
    expect(radius).not.toBeNull();
    // Solo il nodo valido conta (quello senza label usabile e quello senza file
    // sono scartati).
    expect(radius!.nodesTouched).toBe(1);
    expect(radius!.communities).toEqual([{ name: "Core", filesTouched: 1, nodesTouched: 1 }]);
  });

  it("comunità senza nome: etichetta di ripiego dal numero", async () => {
    const path = await writeGraph(
      [
        {
          id: "n1",
          label: "f()",
          source_file: "src/app.ts",
          community: 7,
        } as unknown as FixtureNode,
      ],
      [],
    );
    const radius = await computeBlastRadius({
      graphJsonPath: path,
      changedFiles: ["src/app.ts"],
    });
    expect(radius!.communities).toEqual([
      { name: "Community 7", filesTouched: 1, nodesTouched: 1 },
    ]);
  });
});

const SAMPLE: BlastRadius = {
  communities: [
    { name: "Utils", filesTouched: 1, nodesTouched: 2 },
    { name: "Core", filesTouched: 1, nodesTouched: 1 },
  ],
  godNodes: [{ label: "buildApp()", degree: 12 }],
  nodesTouched: 3,
  filesInGraph: 2,
  filesNotInGraph: 1,
};

const EMPTY: BlastRadius = {
  communities: [],
  godNodes: [],
  nodesTouched: 0,
  filesInGraph: 0,
  filesNotInGraph: 2,
};

describe("renderBlastRadiusPromptBlock", () => {
  it("blocco inglese con comunità, god node e conteggi", () => {
    const block = renderBlastRadiusPromptBlock(SAMPLE);
    expect(block).toContain("Code graph impact");
    expect(block).toContain("Utils (files: 1, symbols: 2)");
    expect(block).toContain("Core (files: 1, symbols: 1)");
    expect(block).toContain("`buildApp()` (degree 12)");
    expect(block).toContain("2");
    expect(block.startsWith("\n")).toBe(false);
  });

  it("senza god node la riga non compare", () => {
    const block = renderBlastRadiusPromptBlock({ ...SAMPLE, godNodes: [] });
    expect(block).not.toContain("Highly connected symbols touched");
    expect(block).toContain("Utils");
  });

  it("null o calcolo vuoto → stringa vuota", () => {
    expect(renderBlastRadiusPromptBlock(null)).toBe("");
    expect(renderBlastRadiusPromptBlock(EMPTY)).toBe("");
  });
});

describe("renderBlastRadiusSection", () => {
  it("sezione italiana per il commento pubblicato", () => {
    const section = renderBlastRadiusSection("it", SAMPLE);
    expect(section).toContain("Impatto sul codice");
    expect(section).toContain("Aree attraversate");
    expect(section).toContain("Utils (file: 1, simboli: 2)");
    expect(section).toContain("`buildApp()` (grado 12)");
    expect(section).toContain("simboli toccati: 3");
    expect(section.startsWith("\n")).toBe(false);
    expect(section.endsWith("\n")).toBe(false);
  });

  it("sezione inglese", () => {
    const section = renderBlastRadiusSection("en", SAMPLE);
    expect(section).toContain("Code impact");
    expect(section).toContain("Areas crossed");
    expect(section).toContain("Utils (files: 1, symbols: 2)");
    expect(section).toContain("`buildApp()` (degree 12)");
  });

  it("null o calcolo vuoto → stringa vuota (sezione omessa)", () => {
    expect(renderBlastRadiusSection("it", null)).toBe("");
    expect(renderBlastRadiusSection("it", EMPTY)).toBe("");
    expect(renderBlastRadiusSection("en", EMPTY)).toBe("");
  });
});
