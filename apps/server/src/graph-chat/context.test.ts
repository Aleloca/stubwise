import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, repoGraphs, repositories, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
import { mirrorSlug } from "@stubwise/shared/mirror-slug";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphMcpClient } from "./client.js";
import {
  appendGraphContext,
  buildGraphContextBlock,
  retrieveGraphContext,
  retrieveGraphContextForProject,
  type GraphContextDeps,
} from "./context.js";

/**
 * Postgres vero (testcontainers) come gli altri test del server: il gating è
 * una query SQL e va verificata sul database, non su un finto repository.
 * Il client MCP invece è FINTO in-process — quello vero ha già i suoi test
 * (client.test.ts, contro un server MCP reale); qui interessa solo COSA gli si
 * chiede e come si reagisce a ciò che risponde.
 * Anche i mirror sono veri (repo bare in tmp), stesso pattern di snippets.test.ts.
 */

/** URL del repository dei test: determina il nome della dir del mirror. */
const REPO_URL = "https://git.example.com/acme/demo.git";

/** Sottografo di esempio nel formato reale di `query_graph` (graphify 0.9.28). */
const SUBGRAPH = [
  "TRAVERSAL from 1 seed(s), depth=2",
  "NODE alpha() [src=src/alpha.ts loc=L20 community=1]",
  "NODE beta() [src=src/beta.ts loc=L40 community=1]",
  "EDGE alpha() -> beta() [kind=calls]",
].join("\n");

let testDb: TestDb;
let root: string;
let mirrorsDir: string;
/** Sha del commit su cui i test fingono che il grafo sia stato costruito. */
let commitSha: string;

const config = {
  graphChatTokenBudget: 1200,
  graphChatSnippetMaxChars: 6000,
  graphChatSnippetNodes: 6,
  get mirrorsDir() {
    return mirrorsDir;
  },
};

/** Logger silenzioso: i log di debug non sono oggetto dei test. */
const logger = { debug: () => undefined };

/** File di 60 righe numerate (il numero di riga compare nel testo). */
function numberedFile(marker: string, lines = 60): string {
  return Array.from({ length: lines }, (_, i) => `riga ${i + 1} ${marker}`).join("\n") + "\n";
}

/** Client MCP finto: `queryGraph` è uno spy pilotato dal singolo test. */
function fakeClient(
  impl: (params: {
    projectPath: string;
    question: string;
    tokenBudget: number;
  }) => Promise<string | null>,
): GraphMcpClient & { queryGraph: ReturnType<typeof vi.fn> } {
  return {
    queryGraph: vi.fn(impl),
    close: async () => undefined,
  } as GraphMcpClient & { queryGraph: ReturnType<typeof vi.fn> };
}

/** Client che risponde sempre col sottografo di esempio. */
function okClient() {
  return fakeClient(async () => SUBGRAPH);
}

function deps(client: GraphMcpClient | null, db: Db = testDb.db): GraphContextDeps {
  return { db, client, config, logger };
}

/**
 * Prepara un repository pronto per il retrieval: toggle acceso, url del mirror
 * di test, riga `repo_graphs` done sul commit indicato. Gli override servono ai
 * test di gating (status diverso, sha nullo, toggle spento).
 */
async function enableGraph(
  repositoryId: string,
  overrides: {
    name?: string;
    graphEnabled?: boolean;
    status?: "none" | "queued" | "running" | "done" | "failed";
    commitSha?: string | null;
    repoUrl?: string;
  } = {},
): Promise<void> {
  await testDb.db
    .update(repositories)
    .set({
      graphEnabled: overrides.graphEnabled ?? true,
      repoUrl: overrides.repoUrl ?? REPO_URL,
      ...(overrides.name ? { name: overrides.name } : {}),
    })
    .where(eq(repositories.id, repositoryId));
  await testDb.db.insert(repoGraphs).values({
    repositoryId,
    status: overrides.status ?? "done",
    commitSha: overrides.commitSha === undefined ? commitSha : overrides.commitSha,
  });
}

beforeAll(async () => {
  testDb = await startTestDb();

  root = await mkdtemp(join(tmpdir(), "graph-context-"));
  const repo = join(root, "source");
  mirrorsDir = join(root, "mirrors");
  await mkdir(join(repo, "src"), { recursive: true });

  const git = (args: string[]) => execa("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "src", "alpha.ts"), numberedFile("alpha"));
  await writeFile(join(repo, "src", "beta.ts"), numberedFile("beta"));
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "commit di test"]);
  commitSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

  await mkdir(mirrorsDir, { recursive: true });
  await execa("git", ["clone", "--bare", "-q", repo, join(mirrorsDir, mirrorSlug(REPO_URL))]);
}, 180_000);

afterAll(async () => {
  await testDb.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await testDb.db.delete(repoGraphs);
  await testDb.db.delete(projects);
});

describe("buildGraphContextBlock", () => {
  it("include istruzioni, sottografo, sha corto e gli estratti", () => {
    const block = buildGraphContextBlock(
      SUBGRAPH,
      [{ path: "src/alpha.ts", startLine: 17, endLine: 20, code: "const a = 1;" }],
      "0123456789abcdef",
    );

    expect(block).toContain("--- STRUTTURA DEL CODICE (knowledge graph al commit 0123456) ---");
    expect(block).toContain(SUBGRAPH);
    expect(block).toContain("--- ESTRATTI DAL CODICE ---");
    expect(block).toContain("### src/alpha.ts:L17-L20");
    expect(block).toContain("const a = 1;");
    // Le due righe di istruzioni al modello.
    expect(block).toContain("STRUTTURALI");
    expect(block).toContain("documentazione");
  });

  it("omette la sezione degli estratti quando non ce ne sono", () => {
    const block = buildGraphContextBlock(SUBGRAPH, [], "0123456789abcdef");

    expect(block).toContain("--- STRUTTURA DEL CODICE");
    expect(block).not.toContain("ESTRATTI DAL CODICE");
  });

  it("usa un fence più lungo se il codice contiene dei backtick tripli", () => {
    const code = "const md = `\n```ts\nx\n```\n`;";
    const block = buildGraphContextBlock(
      SUBGRAPH,
      [{ path: "src/a.ts", startLine: 1, endLine: 5, code }],
      "0123456789abcdef",
    );

    expect(block).toContain("````\n" + code + "\n````");
  });
});

describe("appendGraphContext", () => {
  it("blocco null: il system resta identico byte per byte", () => {
    const system = "SYSTEM PROMPT\n--- CONTESTO RECUPERATO ---\n[1] pagina";
    expect(appendGraphContext(system, null)).toBe(system);
  });

  it("blocco presente: appeso IN CODA (le sue istruzioni citano la documentazione sopra)", () => {
    const system = "SYSTEM PROMPT\n--- CONTESTO RECUPERATO ---\n[1] pagina";
    const block = buildGraphContextBlock(SUBGRAPH, [], "0123456789abcdef");
    const merged = appendGraphContext(system, block);

    expect(merged.startsWith(system)).toBe(true);
    expect(merged.endsWith(block)).toBe(true);
    expect(merged.indexOf("--- CONTESTO RECUPERATO ---")).toBeLessThan(
      merged.indexOf("--- STRUTTURA DEL CODICE"),
    );
  });
});

describe("retrieveGraphContext", () => {
  it("con la feature spenta ritorna null senza toccare il database", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId);
    let dbTouched = false;
    const spiedDb = new Proxy(testDb.db, {
      get(target, prop, receiver) {
        dbTouched = true;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;

    const block = await retrieveGraphContext(deps(null, spiedDb), {
      repositoryId,
      question: "chi chiama alpha?",
    });

    expect(block).toBeNull();
    expect(dbTouched).toBe(false);
  });

  it("senza toggle graphEnabled ritorna null e non interroga il grafo", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId, { graphEnabled: false });
    const client = okClient();

    const block = await retrieveGraphContext(deps(client), {
      repositoryId,
      question: "chi chiama alpha?",
    });

    expect(block).toBeNull();
    expect(client.queryGraph).not.toHaveBeenCalled();
  });

  it("con grafo non ancora costruito ritorna null e non interroga il grafo", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId, { status: "running" });
    const client = okClient();

    const block = await retrieveGraphContext(deps(client), {
      repositoryId,
      question: "chi chiama alpha?",
    });

    expect(block).toBeNull();
    expect(client.queryGraph).not.toHaveBeenCalled();
  });

  it("senza riga repo_graphs ritorna null", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await testDb.db
      .update(repositories)
      .set({ graphEnabled: true })
      .where(eq(repositories.id, repositoryId));
    const client = okClient();

    expect(await retrieveGraphContext(deps(client), { repositoryId, question: "?" })).toBeNull();
    expect(client.queryGraph).not.toHaveBeenCalled();
  });

  it("con commitSha nullo ritorna null (non si saprebbe quale codice leggere)", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId, { commitSha: null });
    const client = okClient();

    expect(await retrieveGraphContext(deps(client), { repositoryId, question: "?" })).toBeNull();
    expect(client.queryGraph).not.toHaveBeenCalled();
  });

  it("happy path: blocco con sottografo, estratti e sha del grafo", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId);
    const client = okClient();

    const block = await retrieveGraphContext(deps(client), {
      repositoryId,
      question: "chi chiama alpha?",
    });

    expect(client.queryGraph).toHaveBeenCalledWith({
      projectPath: `/graphs/${repositoryId}`,
      question: "chi chiama alpha?",
      tokenBudget: 1200,
    });
    expect(block).toContain(
      `--- STRUTTURA DEL CODICE (knowledge graph al commit ${commitSha.slice(0, 7)}) ---`,
    );
    expect(block).toContain("NODE alpha() [src=src/alpha.ts loc=L20 community=1]");
    expect(block).toContain("--- ESTRATTI DAL CODICE ---");
    // Finestra [L-3, L+35] attorno ai due nodi del sottografo.
    expect(block).toContain("### src/alpha.ts:L17-L55");
    expect(block).toContain("riga 20 alpha");
    expect(block).toContain("### src/beta.ts:L37-L60");
    expect(block).toContain("riga 40 beta");
  });

  it("se il grafo non risponde nulla di utile ritorna null", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId);

    const block = await retrieveGraphContext(deps(fakeClient(async () => null)), {
      repositoryId,
      question: "?",
    });

    expect(block).toBeNull();
  });

  it("un'eccezione interna degrada a null", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId);
    const client = fakeClient(async () => {
      throw new Error("boom");
    });

    expect(await retrieveGraphContext(deps(client), { repositoryId, question: "?" })).toBeNull();
  });

  it("senza estratti leggibili resta il solo sottografo", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    // Mirror inesistente per questo url: `git show` fallisce su ogni nodo.
    await enableGraph(repositoryId, { repoUrl: "https://git.example.com/acme/altro.git" });

    const block = await retrieveGraphContext(deps(okClient()), {
      repositoryId,
      question: "?",
    });

    expect(block).toContain("--- STRUTTURA DEL CODICE");
    expect(block).not.toContain("ESTRATTI DAL CODICE");
  });
});

describe("retrieveGraphContextForProject", () => {
  it("con la feature spenta ritorna null", async () => {
    const { projectId } = await seedRepository(testDb.db);

    expect(
      await retrieveGraphContextForProject(deps(null), { projectId, question: "?" }),
    ).toBeNull();
  });

  it("senza repository col grafo pronto ritorna null e non interroga nulla", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const client = okClient();

    expect(
      await retrieveGraphContextForProject(deps(client), { projectId, question: "?" }),
    ).toBeNull();
    expect(client.queryGraph).not.toHaveBeenCalled();
  });

  it("con un solo repository abilitato produce una sola sezione, col budget intero", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    await enableGraph(repositoryId, { name: "solo-repo" });
    // Secondo repository del progetto, senza grafo: non deve comparire.
    await seedRepositoryInProject(testDb.db, projectId);
    const client = okClient();

    const block = await retrieveGraphContextForProject(deps(client), {
      projectId,
      question: "?",
    });

    expect(client.queryGraph).toHaveBeenCalledTimes(1);
    expect(client.queryGraph.mock.calls[0]?.[0]).toMatchObject({ tokenBudget: 1200 });
    expect(block).toContain('Repository "solo-repo"');
    expect(block?.match(/STRUTTURA DEL CODICE/g)).toHaveLength(1);
  });

  it("con due repository abilitati divide il budget e ordina le sezioni per nome", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondId = await seedRepositoryInProject(testDb.db, projectId);
    await enableGraph(repositoryId, { name: "zeta-repo" });
    await enableGraph(secondId, { name: "alfa-repo" });
    const client = okClient();

    const block = await retrieveGraphContextForProject(deps(client), {
      projectId,
      question: "?",
    });

    expect(client.queryGraph).toHaveBeenCalledTimes(2);
    for (const call of client.queryGraph.mock.calls) {
      expect(call[0]).toMatchObject({ tokenBudget: 600 });
    }
    const alfa = block?.indexOf('Repository "alfa-repo"') ?? -1;
    const zeta = block?.indexOf('Repository "zeta-repo"') ?? -1;
    expect(alfa).toBeGreaterThanOrEqual(0);
    expect(zeta).toBeGreaterThan(alfa);
  });

  it("un repository che fallisce non toglie di mezzo gli altri", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondId = await seedRepositoryInProject(testDb.db, projectId);
    await enableGraph(repositoryId, { name: "sano" });
    await enableGraph(secondId, { name: "rotto" });
    const client = fakeClient(async ({ projectPath }) => {
      if (projectPath.endsWith(secondId)) throw new Error("graphify giù");
      return SUBGRAPH;
    });

    const block = await retrieveGraphContextForProject(deps(client), {
      projectId,
      question: "?",
    });

    expect(block).toContain('Repository "sano"');
    expect(block).not.toContain('Repository "rotto"');
  });

  it("se tutti i repository falliscono ritorna null", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondId = await seedRepositoryInProject(testDb.db, projectId);
    await enableGraph(repositoryId, { name: "uno" });
    await enableGraph(secondId, { name: "due" });

    const block = await retrieveGraphContextForProject(deps(fakeClient(async () => null)), {
      projectId,
      question: "?",
    });

    expect(block).toBeNull();
  });
});
