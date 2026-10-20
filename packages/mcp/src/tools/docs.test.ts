import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { StubwiseClient } from "../client.js";
import { docsTools } from "./docs.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

// Isola la rilettura di `.stubwise.json` da process.cwd() (vedi write.test.ts).
let cwdDir: string;
beforeEach(() => {
  cwdDir = mkdtempSync(join(tmpdir(), "stubwise-mcp-docs-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwdDir, { recursive: true, force: true });
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function text(res: ToolResult): string {
  return res.content.map((c) => c.text).join("\n");
}

function makeClient() {
  return {
    getProjectBySlug: vi
      .fn()
      .mockResolvedValue({ id: PROJECT_ID, slug: "audin", name: "Audin AI", backlogEnabled: true }),
    searchProjectDocs: vi.fn(),
    getDocPage: vi.fn(),
  };
}

function makeCtx(client: ReturnType<typeof makeClient>): ToolContext {
  return {
    client: client as unknown as StubwiseClient,
    config: { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null },
  };
}

function tool(name: string): ToolDef {
  const def = docsTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} non registrato`);
  return def;
}

describe("search_project_docs", () => {
  it("rende i passaggi numerati con titolo, repository, testo, repositoryId e slug", async () => {
    const client = makeClient();
    client.searchProjectDocs.mockResolvedValue([
      {
        slug: "posta/gmail",
        title: "Sincronizzazione Gmail",
        snippet: "Le email inviate sono lette ogni 5 minuti.",
        score: 0.82,
        repositoryId: REPO_ID,
        repositoryName: "audin-backend",
      },
      {
        slug: "contatti",
        title: "Contatti",
        snippet: "Un contatto nasce dalla prima email.",
        score: 0.6,
        repositoryId: REPO_ID,
        repositoryName: "audin-backend",
      },
    ]);

    const res = await tool("search_project_docs").handler(
      { project: "audin", query: "email inviate da Gmail" },
      makeCtx(client),
    );

    expect(client.searchProjectDocs).toHaveBeenCalledWith(PROJECT_ID, "email inviate da Gmail");
    expect(res.isError).toBeUndefined();
    const out = text(res);
    expect(out).toContain("1. Sincronizzazione Gmail");
    expect(out).toContain("2. Contatti");
    expect(out).toContain("audin-backend");
    expect(out).toContain("Le email inviate sono lette ogni 5 minuti.");
    expect(out).toContain(`repositoryId: ${REPO_ID}`);
    expect(out).toContain("slug: posta/gmail");
    expect(out).toContain("read_doc_page");
  });

  it("nessun passaggio → dice esplicitamente che la documentazione non ne parla", async () => {
    const client = makeClient();
    client.searchProjectDocs.mockResolvedValue([]);

    const res = await tool("search_project_docs").handler(
      { project: "audin", query: "fatture elettroniche" },
      makeCtx(client),
    );

    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("la documentazione non ne parla");
  });

  it("progetto inesistente → errore parlante, nessuna ricerca", async () => {
    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(null);

    const res = await tool("search_project_docs").handler(
      { project: "ghost", query: "x" },
      makeCtx(client),
    );

    expect(res.isError).toBe(true);
    expect(client.searchProjectDocs).not.toHaveBeenCalled();
  });
});

describe("read_doc_page", () => {
  it("restituisce titolo e testo della pagina", async () => {
    const client = makeClient();
    client.getDocPage.mockResolvedValue({
      title: "Sincronizzazione Gmail",
      body: "# Gmail\nTesto della pagina.",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    const res = await tool("read_doc_page").handler(
      { repositoryId: REPO_ID, slug: "posta/gmail" },
      makeCtx(client),
    );

    expect(client.getDocPage).toHaveBeenCalledWith(REPO_ID, "posta/gmail");
    expect(text(res)).toContain("Sincronizzazione Gmail");
    expect(text(res)).toContain("Testo della pagina.");
    expect(text(res)).not.toContain("pagina troncata");
  });

  it("pagina di 40.000 caratteri → troncata a 30.000 con l'avviso in fondo", async () => {
    const client = makeClient();
    const body = "a".repeat(30_000) + "b".repeat(10_000);
    client.getDocPage.mockResolvedValue({
      title: "Lunga",
      body,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    const res = await tool("read_doc_page").handler(
      { repositoryId: REPO_ID, slug: "lunga" },
      makeCtx(client),
    );

    const out = text(res);
    expect(out).toContain("a".repeat(30_000));
    expect(out).not.toContain("ab");
    const lines = out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^\(pagina troncata: /);
  });

  it("repositoryId che non è un uuid → errore, nessuna chiamata (niente path steering)", async () => {
    const client = makeClient();
    const def = tool("read_doc_page");

    expect(
      z.object(def.inputSchema).safeParse({ repositoryId: "../../api/users", slug: "x" }).success,
    ).toBe(false);
    const res = await def.handler({ repositoryId: "../../api/users", slug: "x" }, makeCtx(client));

    expect(res.isError).toBe(true);
    expect(client.getDocPage).not.toHaveBeenCalled();
  });
});
