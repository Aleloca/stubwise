import { describe, expect, it } from "vitest";
import { parseSubgraphNodes } from "./subgraph.js";

/**
 * Fixture presa da un'esecuzione REALE di `query_graph` (graphify 0.9.28) sul
 * grafo di questo repository: header del traversal, avviso di troncamento,
 * righe NODE e righe EDGE. Il parser deve reggerla verbatim.
 */
const REAL_OUTPUT = `Traversal: BFS depth=2 | Start: ['BacklogCodeSessionStatus', 'code-session.ts'] | 1040 nodes found

[!] TRUNCATED: showing 33 of 1040 nodes (~900-token budget). Refine the question to narrow the traversal.

NODE BacklogCodeSessionStatus [src=packages/shared/src/schemas/backlog.ts loc=L120 community=37]
NODE backlogCodeSessionStatusSchema [src=packages/shared/src/schemas/backlog.ts loc=L119 community=37]
NODE code-session.ts [src=apps/worker/src/backlog/code-session.ts loc=L1 community=17]
NODE streamChatResponse() [src=apps/server/src/routes/docs-chat-core.ts loc=L106 community=5]
EDGE BacklogCodeSessionStatus -> backlogCodeSessionStatusSchema [type=derives_from]
EDGE code-session.ts -> streamChatResponse() [type=calls]
`;

describe("parseSubgraphNodes", () => {
  it("estrae i nodi con src e loc mantenendo l'ordine del sottografo", () => {
    const nodes = parseSubgraphNodes(REAL_OUTPUT);

    // `code-session.ts` è un nodo-file (loc=L1, label = basename): scartato.
    expect(nodes).toEqual([
      {
        label: "BacklogCodeSessionStatus",
        path: "packages/shared/src/schemas/backlog.ts",
        line: 120,
      },
      {
        label: "streamChatResponse()",
        path: "apps/server/src/routes/docs-chat-core.ts",
        line: 106,
      },
    ]);
  });

  it("scarta i nodi-file anche quando la label è il basename senza estensione", () => {
    const text = [
      "NODE mirrors [src=apps/worker/src/git/mirrors.ts loc=L1]",
      "NODE mirrors.ts [src=apps/worker/src/git/mirrors.ts loc=L1]",
      "NODE README.md [src=README.md loc=L1]",
    ].join("\n");

    expect(parseSubgraphNodes(text)).toEqual([]);
  });

  it("tiene un nodo a riga 1 se la label NON è il basename del file", () => {
    const text = "NODE createApp() [src=apps/server/src/app.ts loc=L1]";

    expect(parseSubgraphNodes(text)).toEqual([
      { label: "createApp()", path: "apps/server/src/app.ts", line: 1 },
    ]);
  });

  it("scarta i quasi-duplicati: stesso file e righe vicine (< 10)", () => {
    const text = [
      "NODE alpha [src=src/a.ts loc=L100]",
      "NODE beta [src=src/a.ts loc=L108]", // 8 righe di distanza → duplicato
      "NODE gamma [src=src/a.ts loc=L92]", // 8 righe sotto → duplicato
      "NODE delta [src=src/a.ts loc=L130]", // lontano → tenuto
      "NODE epsilon [src=src/b.ts loc=L101]", // altro file → tenuto
    ].join("\n");

    expect(parseSubgraphNodes(text).map((n) => n.label)).toEqual(["alpha", "delta", "epsilon"]);
  });

  it("ignora righe malformate, EDGE, header e nodi senza src o senza loc", () => {
    const text = [
      "Traversal: BFS depth=2 | Start: ['x'] | 3 nodes found",
      "NODE senzaAttributi",
      "NODE senzaLoc [src=src/a.ts community=3]",
      "NODE senzaSrc [loc=L12 community=3]",
      "NODE locNonNumerica [src=src/a.ts loc=Lxx]",
      "EDGE a -> b [type=calls]",
      "   ",
      "NODE buono [src=src/c.ts loc=L7 community=1]",
    ].join("\n");

    expect(parseSubgraphNodes(text)).toEqual([
      { label: "buono", path: "src/c.ts", line: 7 },
    ]);
  });

  it("tollera l'assenza di attributi dopo src/loc e l'ordine invertito", () => {
    const text = [
      "NODE uno [loc=L42 src=src/a.ts]",
      "NODE due [src=src/b.ts community=9 loc=L3 degree=12]",
    ].join("\n");

    expect(parseSubgraphNodes(text)).toEqual([
      { label: "uno", path: "src/a.ts", line: 42 },
      { label: "due", path: "src/b.ts", line: 3 },
    ]);
  });

  it("ritorna una lista vuota su testo vuoto", () => {
    expect(parseSubgraphNodes("")).toEqual([]);
  });
});
