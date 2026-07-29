import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { summarizeGraphForDocs } from "./docs-summary.js";

/** Nodo della fixture: stessi campi del graph.json reale (node-link NetworkX). */
interface FixtureNode {
  id: string;
  label: string;
  source_file: string;
  community?: number;
  community_name?: string;
}

let dir: string;
let seq = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docs-summary-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Scrive un graph.json node-link nella tmp dir e ne ritorna il path. */
async function writeGraph(
  nodes: FixtureNode[],
  links: { source: string; target: string }[] = [],
): Promise<string> {
  const path = join(dir, `graph-${seq++}.json`);
  await writeFile(
    path,
    JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes, links }),
  );
  return path;
}

/** Scrive un contenuto arbitrario (non JSON valido) e ne ritorna il path. */
async function writeRaw(content: string): Promise<string> {
  const path = join(dir, `raw-${seq++}.json`);
  await writeFile(path, content);
  return path;
}

/**
 * Grafo di riferimento: due comunità di dimensione diversa (per l'ordinamento) e un
 * hub con grado 12 (sopra il pavimento dei god node).
 *  - "Core": 1 simbolo hub in src/app.ts, collegato alle 12 route;
 *  - "Routes": 12 simboli, uno per file, ma 3 di essi nello STESSO file (frequenza).
 */
async function writeReferenceGraph(): Promise<string> {
  const nodes: FixtureNode[] = [
    { id: "hub", label: "buildApp()", source_file: "src/app.ts", community: 1, community_name: "Core" },
  ];
  const links: { source: string; target: string }[] = [];
  for (let i = 1; i <= 12; i++) {
    // I primi 3 simboli vivono tutti in routes/index.ts: è il file più frequente.
    const file = i <= 3 ? "src/routes/index.ts" : `src/routes/route${i}.ts`;
    nodes.push({
      id: `leaf${i}`,
      label: `route${i}()`,
      source_file: file,
      community: 2,
      community_name: "Routes",
    });
    links.push({ source: "hub", target: `leaf${i}` });
  }
  return writeGraph(nodes, links);
}

describe("summarizeGraphForDocs", () => {
  it("rende comunità (dimensione decrescente, conteggi, file rappresentativi) e god node", async () => {
    const summary = await summarizeGraphForDocs(await writeReferenceGraph());
    expect(summary).not.toBeNull();
    const text = summary as string;

    // Intestazione riconoscibile + avvertenza di verifica in coda.
    expect(text).toContain("CODE GRAPH MAP");
    expect(text.toLowerCase()).toMatch(/verify/);

    // Comunità: la più grande (Routes, 12 simboli) prima di Core (1 simbolo).
    expect(text).toContain("Routes");
    expect(text).toContain("Core");
    expect(text.indexOf("Routes")).toBeLessThan(text.indexOf("Core"));
    // Conteggio dei nodi della comunità.
    expect(text).toMatch(/Routes[^\n]*12/);
    // File rappresentativi: il più frequente della comunità in testa.
    expect(text).toMatch(/Routes[^\n]*src\/routes\/index\.ts/);
    expect(text).toContain("src/app.ts");

    // God node: l'hub con grado 12 col suo file.
    expect(text).toContain("buildApp()");
    expect(text).toMatch(/buildApp\(\)[^\n]*12/);
    // Una route con grado 1 NON è un hub.
    expect(text).not.toContain("route7()");
  });

  it("è deterministica: due chiamate producono la stessa stringa", async () => {
    const path = await writeReferenceGraph();
    expect(await summarizeGraphForDocs(path)).toBe(await summarizeGraphForDocs(path));
  });

  it("cap: comunità, god node e file rappresentativi troncati", async () => {
    const nodes: FixtureNode[] = [];
    const links: { source: string; target: string }[] = [];
    // 20 comunità da 1 simbolo + una comunità "Big" con 10 file distinti.
    for (let c = 1; c <= 20; c++) {
      nodes.push({
        id: `c${c}`,
        label: `sym${c}()`,
        source_file: `src/c${c}/index.ts`,
        community: c,
        community_name: `Community-${c}`,
      });
    }
    for (let f = 1; f <= 10; f++) {
      nodes.push({
        id: `big${f}`,
        label: `big${f}()`,
        source_file: `src/big/file${f}.ts`,
        community: 99,
        community_name: "Big",
      });
    }
    const path = await writeGraph(nodes, links);

    const capped = await summarizeGraphForDocs(path, {
      maxCommunities: 3,
      maxGodNodes: 2,
      maxFilesPerCommunity: 2,
    });
    expect(capped).not.toBeNull();
    const text = capped as string;
    // Solo 3 comunità rese (una riga ciascuna sotto l'intestazione delle aree).
    const communityLines = text.split("\n").filter((l) => /^- .*\(\d+ symbols?, \d+ files?\):/.test(l));
    expect(communityLines).toHaveLength(3);
    // La riga di "Big" elenca al massimo 2 file.
    const bigLine = communityLines.find((l) => l.includes("Big"));
    expect(bigLine).toBeDefined();
    expect((bigLine as string).match(/src\/big\/file\d+\.ts/g) ?? []).toHaveLength(2);
  });

  it("cap di default: al massimo 15 comunità e 10 god node", async () => {
    const nodes: FixtureNode[] = [];
    const links: { source: string; target: string }[] = [];
    // 30 comunità, ognuna con un hub collegato a 12 foglie della stessa comunità:
    // 30 candidati god node (grado 12) e 30 comunità.
    for (let c = 1; c <= 30; c++) {
      nodes.push({
        id: `hub${c}`,
        label: `hub${c}()`,
        source_file: `src/c${c}/hub.ts`,
        community: c,
        community_name: `Community-${c}`,
      });
      for (let i = 1; i <= 12; i++) {
        nodes.push({
          id: `n${c}-${i}`,
          label: `n${c}_${i}()`,
          source_file: `src/c${c}/f${i}.ts`,
          community: c,
          community_name: `Community-${c}`,
        });
        links.push({ source: `hub${c}`, target: `n${c}-${i}` });
      }
    }
    const text = (await summarizeGraphForDocs(await writeGraph(nodes, links))) as string;
    expect(text).not.toBeNull();
    const communityLines = text.split("\n").filter((l) => /^- .*\(\d+ symbols?, \d+ files?\):/.test(l));
    expect(communityLines).toHaveLength(15);
    const godLines = text.split("\n").filter((l) => l.includes("degree "));
    expect(godLines).toHaveLength(10);
  });

  it("comunità senza nome: etichetta di ripiego dal numero", async () => {
    const text = (await summarizeGraphForDocs(
      await writeGraph([
        { id: "a", label: "a()", source_file: "src/a.ts", community: 7 },
        { id: "b", label: "b()", source_file: "src/b.ts", community: 7 },
      ]),
    )) as string;
    expect(text).toContain("Community 7");
  });

  it("fail-open: file assente, JSON corrotto, forma inattesa, grafo vuoto → null (mai throw)", async () => {
    await expect(summarizeGraphForDocs(join(dir, "non-esiste.json"))).resolves.toBeNull();
    await expect(summarizeGraphForDocs(await writeRaw("{ non json"))).resolves.toBeNull();
    await expect(summarizeGraphForDocs(await writeRaw('"stringa"'))).resolves.toBeNull();
    await expect(summarizeGraphForDocs(await writeRaw('{"nodes": 42}'))).resolves.toBeNull();
    await expect(summarizeGraphForDocs(await writeGraph([]))).resolves.toBeNull();
  });

  it("nodi malformati ignorati senza lanciare; nessuna comunità → null", async () => {
    const path = await writeRaw(
      JSON.stringify({
        nodes: [
          null,
          "stringa",
          { id: "ok" },
          // Nodo valido ma SENZA comunità: niente aree e nessun hub → nulla da dire.
          { id: "x", label: "x()", source_file: "src/x.ts" },
        ],
        links: [null, { source: 1, target: 2 }],
      }),
    );
    await expect(summarizeGraphForDocs(path)).resolves.toBeNull();
  });

  it("nessuna comunità ma un god node: la mappa esiste comunque", async () => {
    const nodes: FixtureNode[] = [{ id: "hub", label: "hub()", source_file: "src/hub.ts" }];
    const links: { source: string; target: string }[] = [];
    for (let i = 1; i <= 12; i++) {
      nodes.push({ id: `n${i}`, label: `n${i}()`, source_file: `src/n${i}.ts` });
      links.push({ source: "hub", target: `n${i}` });
    }
    const text = (await summarizeGraphForDocs(await writeGraph(nodes, links))) as string;
    expect(text).not.toBeNull();
    expect(text).toContain("hub()");
  });
});
