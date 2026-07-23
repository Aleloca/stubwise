import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { resolveProject } from "./shared.js";
import type { ToolContext } from "./types.js";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Progetto finto (solo i campi che i tool usano). */
function fakeProject(slug: string) {
  return {
    id: PROJECT_ID,
    name: "Acme",
    slug,
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: true,
    ingestionKey: "ingest_key",
    nextTicketNumber: 1,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

/** Client mockato: solo i metodi toccati da resolveProject. */
function makeClient() {
  return { getProjectBySlug: vi.fn() };
}

function makeCtx(
  client: ReturnType<typeof makeClient>,
  config: Partial<StubwiseConfig> = {},
): ToolContext {
  const fullConfig: StubwiseConfig = {
    baseUrl: "https://stubwise.example.com",
    token: "stw_pat_secret",
    projectSlug: null,
    ...config,
  };
  return { client: client as unknown as StubwiseClient, config: fullConfig };
}

describe("resolveProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-mcp-shared-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rilegge lo slug FRESCO da .stubwise.json anche se config.projectSlug è null", async () => {
    // Simula il file creato DOPO l'avvio del server: la config caricata all'avvio
    // ha projectSlug null, ma .stubwise.json ora esiste nella cwd.
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "fresh-project" }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject("fresh-project"));

    const resolved = await resolveProject(undefined, makeCtx(client, { projectSlug: null }));

    expect(client.getProjectBySlug).toHaveBeenCalledWith("fresh-project");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.project.slug).toBe("fresh-project");
  });

  it("l'argSlug esplicito ha precedenza sulla rilettura di .stubwise.json", async () => {
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "file-project" }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject("arg-project"));

    const resolved = await resolveProject("arg-project", makeCtx(client, { projectSlug: null }));

    expect(client.getProjectBySlug).toHaveBeenCalledWith("arg-project");
    expect(resolved.ok).toBe(true);
  });

  it("usa config.projectSlug come fallback quando non c'è argSlug né .stubwise.json", async () => {
    // cwd senza .stubwise.json → readProjectSlug ritorna null → fallback config.
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(fakeProject("startup-project"));

    const resolved = await resolveProject(
      undefined,
      makeCtx(client, { projectSlug: "startup-project" }),
    );

    expect(client.getProjectBySlug).toHaveBeenCalledWith("startup-project");
    expect(resolved.ok).toBe(true);
  });

  it("errore parlante (/stubwise:init) quando non c'è alcuno slug", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const client = makeClient();
    const resolved = await resolveProject(undefined, makeCtx(client, { projectSlug: null }));

    expect(client.getProjectBySlug).not.toHaveBeenCalled();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.result.content[0]?.text).toMatch(/\/stubwise:init/);
  });

  it("errore 'Progetto <slug> non trovato' quando il client non trova il progetto", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const client = makeClient();
    client.getProjectBySlug.mockResolvedValue(null);

    const resolved = await resolveProject("ghost", makeCtx(client, { projectSlug: null }));

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.result.content[0]?.text).toMatch(/Progetto 'ghost' non trovato/);
  });
});
