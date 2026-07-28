import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GRAPHIFY_AGENT_ALLOWED_TOOLS,
  renderGraphHint,
  resolveRepoGraphJson,
} from "./agent-hint.js";

/**
 * Hint del grafo nei prompt degli agenti: risoluzione del path sul volume
 * (esistenza del graph.json come fonte di verità) e resa del blocco di prompt
 * nelle due lingue, con la variante singolo/multi repo.
 */
describe("agent-hint del grafo", () => {
  let graphsDir: string;
  const repoWithGraph = "11111111-1111-1111-1111-111111111111";
  const repoWithout = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    graphsDir = await mkdtemp(join(tmpdir(), "graphs-"));
    await mkdir(join(graphsDir, repoWithGraph, "graphify-out"), { recursive: true });
    await writeFile(join(graphsDir, repoWithGraph, "graphify-out", "graph.json"), "{}");
  });

  afterAll(async () => {
    await rm(graphsDir, { recursive: true, force: true });
  });

  it("risolve il path quando il graph.json esiste sul volume", () => {
    expect(resolveRepoGraphJson(graphsDir, repoWithGraph)).toBe(
      join(graphsDir, repoWithGraph, "graphify-out", "graph.json"),
    );
  });

  it("null quando il grafo non è mai stato costruito", () => {
    expect(resolveRepoGraphJson(graphsDir, repoWithout)).toBeNull();
  });

  it("nessun grafo → blocco vuoto (niente rumore nel prompt)", () => {
    expect(renderGraphHint([], "en")).toBe("");
    expect(renderGraphHint([], "it")).toBe("");
  });

  it("singolo grafo: comandi con --graph e path inline, in entrambe le lingue", () => {
    const en = renderGraphHint([{ graphJsonPath: "/graphs/x/graphify-out/graph.json" }], "en");
    expect(en).toContain("CODE GRAPH");
    expect(en).toContain('graphify query "<question>" --graph <path>');
    expect(en).toContain("/graphs/x/graphify-out/graph.json");
    const it_ = renderGraphHint([{ graphJsonPath: "/graphs/x/graphify-out/graph.json" }], "it");
    expect(it_).toContain("GRAFO DEL CODICE");
    expect(it_).toContain('graphify query "<domanda>" --graph <path>');
    expect(it_).toContain("/graphs/x/graphify-out/graph.json");
  });

  it("multi repo: un path per grafo con la label del repository", () => {
    const out = renderGraphHint(
      [
        { label: "api", graphJsonPath: "/graphs/a/graphify-out/graph.json" },
        { label: "web", graphJsonPath: "/graphs/b/graphify-out/graph.json" },
      ],
      "en",
    );
    expect(out).toContain("- api: `/graphs/a/graphify-out/graph.json`");
    expect(out).toContain("- web: `/graphs/b/graphify-out/graph.json`");
  });

  it("l'allowlist copre solo i sottocomandi read-only di interrogazione", () => {
    expect(GRAPHIFY_AGENT_ALLOWED_TOOLS).toEqual([
      "Bash(graphify query:*)",
      "Bash(graphify explain:*)",
      "Bash(graphify path:*)",
    ]);
  });
});

/**
 * Integrazione nei PROMPT reali: il blocco del grafo compare solo quando il
 * chiamante passa il path, in tutte le superfici (fix EN, backlog IT).
 */
describe("blocco del grafo nei prompt degli agenti", () => {
  const ticket = {
    title: "Bug di prova",
    type: "bug",
    priority: "medium",
    source: "manual",
    occurrences: 1,
    body: "corpo",
    technicalPayload: null,
  };

  it("fix: blocco CODE GRAPH con --graph quando il repo ha il grafo, assente altrimenti", async () => {
    const { buildFixPrompt, buildFixPlanPrompt } = await import("../pipeline/prompts.js");
    const repos = [
      { dir: "api", name: "API", graphJsonPath: "/graphs/a/graphify-out/graph.json" },
      { dir: "web", name: "Web" },
    ];
    for (const build of [buildFixPrompt, buildFixPlanPrompt]) {
      const withGraph = build({ ticket, repos } as Parameters<typeof build>[0], "en");
      expect(withGraph).toContain("CODE GRAPH");
      expect(withGraph).toContain("- ./api/: `/graphs/a/graphify-out/graph.json`");
      const without = build(
        { ticket, repos: [{ dir: "web", name: "Web" }] } as Parameters<typeof build>[0],
        "en",
      );
      expect(without).not.toContain("CODE GRAPH");
    }
  });

  it("deep dive: blocco GRAFO DEL CODICE gated dal graphJsonPath", async () => {
    const { buildDeepDivePrompt } = await import("../backlog/prompts.js");
    const base = { title: "T", document: "doc", effort: null, risk: null, urgency: null };
    expect(
      buildDeepDivePrompt({ ...base, graphJsonPath: "/graphs/x/graphify-out/graph.json" }),
    ).toContain("GRAFO DEL CODICE");
    expect(buildDeepDivePrompt(base)).not.toContain("GRAFO DEL CODICE");
  });

  it("sessione di analisi (priming): blocco gated dal graphJsonPath", async () => {
    const { buildCodeChatPrimingPrompt } = await import("../backlog/prompts.js");
    const base = {
      title: "T",
      document: "doc",
      effort: null,
      risk: null,
      urgency: null,
      history: [],
      question: "come funziona?",
      language: "it" as const,
    };
    expect(
      buildCodeChatPrimingPrompt({ ...base, graphJsonPath: "/graphs/x/graphify-out/graph.json" }),
    ).toContain("GRAFO DEL CODICE");
    expect(buildCodeChatPrimingPrompt(base)).not.toContain("GRAFO DEL CODICE");
  });
});
