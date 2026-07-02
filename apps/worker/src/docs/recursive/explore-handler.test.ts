import { docGenerations, docNodes, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  SOURCE_PATHS_END_MARKER,
  SOURCE_PATHS_START_MARKER,
} from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../../agent/fake.js";
import type { AgentRunUsage } from "../../agent/runner.js";
import { claimNextNode, type DocNode } from "../nodes.js";
import { runExplore, type RunExploreDeps } from "./explore-handler.js";

// Test del handler di esplorazione (M5.3): nodi inseriti direttamente in doc_nodes
// (niente worktree git reale — FakeAgentRunner ignora il cwd), reclamati via
// claimNextNode così sono `exploring`, e un FakeAgentRunner scriptato a produrre
// l'output di explore marcato. Si asseriscono: ramo (body+paths scritti, figli creati,
// padre awaiting_children/pendingChildren=N), foglia (done + join), output invalido
// (retry → failNode + join), dedup (figlio coperto da antenato scartato), cap di
// profondità (figli ignorati → foglia).

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let repositoryId: string;
let generationId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  const { db } = testDb;
  ({ repositoryId } = await seedRepository(db));
  const [generation] = await db.insert(docGenerations).values({ repositoryId }).returning();
  if (!generation) throw new Error("insert della generazione non ha restituito la riga");
  generationId = generation.id;
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(docNodes);
});

afterAll(async () => {
  await testDb.stop();
});

interface InsertNodeOptions {
  parentId?: string;
  tree?: DocNode["tree"];
  status?: DocNode["status"];
  pendingChildren?: number;
  depth?: number;
  title?: string;
  body?: string;
  sourcePaths?: string[];
  unitRef?: string;
}

async function insertNode(db: Db, opts: InsertNodeOptions = {}): Promise<DocNode> {
  const { tree, ...rest } = opts;
  const [node] = await db
    .insert(docNodes)
    .values({ generationId, repositoryId, tree: tree ?? "technical", ...rest })
    .returning();
  if (!node) throw new Error("insert del nodo non ha restituito la riga");
  return node;
}

async function getNode(db: Db, id: string): Promise<DocNode> {
  const [node] = await db.select().from(docNodes).where(eq(docNodes.id, id));
  if (!node) throw new Error(`nodo ${id} non trovato`);
  return node;
}

/** Reclama il nodo (pending → exploring) così l'handler ha la ownership. */
async function claim(db: Db): Promise<DocNode> {
  const claimed = await claimNextNode(db);
  if (!claimed) throw new Error("nessun nodo claimabile");
  return claimed.node;
}

const USAGE: AgentRunUsage = { totalCostUsd: 0.03, models: [] };

function baseDeps(
  db: Db,
  runner: FakeAgentRunner,
  overrides: Partial<RunExploreDeps> = {},
): RunExploreDeps {
  return {
    db,
    runner,
    worktreeDir: "/tmp/fake-worktree",
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
    maxDepth: 6,
    maxNodes: 400,
    ...overrides,
  };
}

/** Output di explore ben formato con body, figli (righe) e source-paths dati. */
function exploreOutput(opts: {
  body?: string;
  children?: string[];
  paths?: string[];
}): string {
  const body =
    opts.body ??
    "### Panoramica\nQuesto modulo coordina le richieste in ingresso e instrada verso i sottosistemi. Contiene la logica centrale del dominio applicativo.";
  return [
    EXPLORE_BODY_START_MARKER,
    body,
    EXPLORE_BODY_END_MARKER,
    EXPLORE_CHILDREN_START_MARKER,
    ...(opts.children ?? []),
    EXPLORE_CHILDREN_END_MARKER,
    SOURCE_PATHS_START_MARKER,
    ...(opts.paths ?? []).map((p) => `- ${p}`),
    SOURCE_PATHS_END_MARKER,
  ].join("\n");
}

describe("runExplore", () => {
  it("ramo: scrive body/paths, crea 2 figli pending depth+1, padre awaiting_children pendingChildren=2", async () => {
    const { db } = testDb;
    await insertNode(db, { title: "Core", unitRef: "src/core", depth: 1 });
    const node = await claim(db);

    const output = exploreOutput({
      children: [
        "- Routing :: src/core/routing :: instrada le richieste",
        "- Domain :: src/core/domain :: la logica di dominio",
      ],
      paths: ["src/core"],
    });
    const runner = new FakeAgentRunner({
      script: () => ({ output, exitCode: 0, usage: USAGE }),
    });

    const result = await runExplore(baseDeps(db, runner), node);
    expect(result.outcome).toBe("branch");
    expect(result.costUsd).toBeCloseTo(0.03, 6);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    expect(runner.calls[0]?.model).toBe("opus");
    expect(runner.calls[0]?.cwd).toBe("/tmp/fake-worktree");

    const parent = await getNode(db, node.id);
    expect(parent.status).toBe("awaiting_children");
    expect(parent.pendingChildren).toBe(2);
    expect(parent.body).toContain("Panoramica");
    expect(parent.sourcePaths).toEqual(["src/core"]);

    const children = await db.select().from(docNodes).where(eq(docNodes.parentId, node.id));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.status).toBe("pending");
      expect(child.depth).toBe(node.depth + 1);
      expect(child.tree).toBe("technical");
    }
    expect(children.map((c) => c.title).sort()).toEqual(["Domain", "Routing"]);
    const routing = children.find((c) => c.title === "Routing");
    expect(routing?.unitRef).toBe("src/core/routing");
    expect(routing?.sourcePaths).toEqual(["src/core/routing"]);
  });

  it("foglia: nessun figlio → nodo done, join sul padre decrementa pendingChildren", async () => {
    const { db } = testDb;
    const root = await insertNode(db, {
      title: "Root",
      status: "awaiting_children",
      pendingChildren: 1,
      depth: 0,
    });
    await insertNode(db, { parentId: root.id, title: "Leaf", unitRef: "src/leaf", depth: 1 });
    const node = await claim(db);

    const runner = new FakeAgentRunner({
      script: () => ({ output: exploreOutput({ children: [], paths: ["src/leaf"] }), exitCode: 0, usage: USAGE }),
    });

    const result = await runExplore(baseDeps(db, runner), node);
    expect(result.outcome).toBe("leaf");

    const leaf = await getNode(db, node.id);
    expect(leaf.status).toBe("done");
    expect(leaf.finishedAt).not.toBeNull();
    expect(leaf.body).toContain("Panoramica");

    // Join: il padre è sceso a 0 pendingChildren e ora è ready_to_synthesize.
    const parent = await getNode(db, root.id);
    expect(parent.pendingChildren).toBe(0);
    expect(parent.status).toBe("ready_to_synthesize");
  });

  it("output invalido (niente marcatori) → retry → failNode, join sul padre avanza", async () => {
    const { db } = testDb;
    const root = await insertNode(db, {
      title: "Root",
      status: "awaiting_children",
      pendingChildren: 1,
      depth: 0,
    });
    await insertNode(db, { parentId: root.id, title: "Broken", unitRef: "src/x", depth: 1 });
    const node = await claim(db);

    const runner = new FakeAgentRunner({
      script: () => ({ output: "prosa libera senza marcatori del contratto", exitCode: 0, usage: USAGE }),
    });

    const result = await runExplore(baseDeps(db, runner), node);
    expect(result.outcome).toBe("failed");
    // Retry: due invocazioni prima del fallback.
    expect(runner.calls).toHaveLength(2);

    const failed = await getNode(db, node.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/marcatori|non valido/i);

    // Il join è comunque avanzato (niente deadlock del padre).
    const parent = await getNode(db, root.id);
    expect(parent.pendingChildren).toBe(0);
    expect(parent.status).toBe("ready_to_synthesize");

    // Nessun figlio creato.
    const children = await db.select().from(docNodes).where(eq(docNodes.parentId, node.id));
    expect(children).toHaveLength(0);
  });

  it("dedup: un figlio il cui path è coperto da un antenato non viene creato", async () => {
    const { db } = testDb;
    // Antenato (radice) che copre src/core; il nodo esplorato è il suo figlio.
    const root = await insertNode(db, {
      title: "Root",
      status: "awaiting_children",
      pendingChildren: 1,
      depth: 0,
      sourcePaths: ["src/core"],
    });
    await insertNode(db, {
      parentId: root.id,
      title: "Core",
      unitRef: "src/core/sub",
      depth: 1,
      sourcePaths: ["src/core/sub"],
    });
    const node = await claim(db);

    // Un figlio nuovo (src/other) + uno coperto dall'antenato (src/core/again ⊂ src/core).
    const runner = new FakeAgentRunner({
      script: () => ({
        output: exploreOutput({
          children: [
            "- Other :: src/other :: nuovo",
            "- Covered :: src/core/again :: già coperto dall'antenato",
          ],
          paths: ["src/core/sub"],
        }),
        exitCode: 0,
        usage: USAGE,
      }),
    });

    const result = await runExplore(baseDeps(db, runner), node);
    expect(result.outcome).toBe("branch");

    const children = await db.select().from(docNodes).where(eq(docNodes.parentId, node.id));
    // Solo "Other" creato; "Covered" scartato dall'anti-ciclo.
    expect(children.map((c) => c.title)).toEqual(["Other"]);

    const parent = await getNode(db, node.id);
    expect(parent.pendingChildren).toBe(1);
  });

  it("run al limite del provider: outcome 'limit', UN solo run (retry non consumato), nodo NON failed", async () => {
    const { db } = testDb;
    const root = await insertNode(db, {
      title: "Root",
      status: "awaiting_children",
      pendingChildren: 1,
      depth: 0,
    });
    await insertNode(db, { parentId: root.id, title: "Limited", unitRef: "src/x", depth: 1 });
    const node = await claim(db);

    const runner = new FakeAgentRunner({
      script: () => ({
        output: "API Error: usage limit reached",
        exitCode: 1,
        usage: { totalCostUsd: 0.01, models: [] },
      }),
    });

    const result = await runExplore(baseDeps(db, runner), node);
    expect(result.outcome).toBe("limit");
    // Il costo del run parziale è comunque riportato al chiamante.
    expect(result.costUsd).toBeCloseTo(0.01, 6);
    // Il limite NON consuma il retry: ogni retry sarebbe un run bruciato.
    expect(runner.calls).toHaveLength(1);

    // Il nodo NON è failed: resta in lavorazione (il dispatcher lo riaccoderà).
    const after = await getNode(db, node.id);
    expect(after.status).toBe("exploring");
    // Nessun join sul padre: il nodo non è concluso.
    const parent = await getNode(db, root.id);
    expect(parent.pendingChildren).toBe(1);
    expect(parent.status).toBe("awaiting_children");
  });

  it("cap di profondità: a DOC_MAX_DEPTH i figli proposti sono ignorati → foglia", async () => {
    const { db } = testDb;
    // maxDepth=3: un nodo a depth 2 avrebbe figli a depth 3 = maxDepth → foglia.
    const root = await insertNode(db, {
      title: "Root",
      status: "awaiting_children",
      pendingChildren: 1,
      depth: 1,
    });
    await insertNode(db, { parentId: root.id, title: "Deep", unitRef: "src/deep", depth: 2 });
    const node = await claim(db);

    const runner = new FakeAgentRunner({
      script: () => ({
        output: exploreOutput({
          children: ["- Ignored :: src/deep/sub :: dovrebbe essere ignorato"],
          paths: ["src/deep"],
        }),
        exitCode: 0,
        usage: USAGE,
      }),
    });

    const result = await runExplore(baseDeps(db, runner, { maxDepth: 3 }), node);
    expect(result.outcome).toBe("leaf");

    // Nessun figlio creato (cap di profondità), nodo done.
    const children = await db.select().from(docNodes).where(eq(docNodes.parentId, node.id));
    expect(children).toHaveLength(0);
    const leaf = await getNode(db, node.id);
    expect(leaf.status).toBe("done");
    // Il body è comunque stato scritto (la pagina esiste, solo non si decompone).
    expect(leaf.body).toContain("Panoramica");
  });
});
