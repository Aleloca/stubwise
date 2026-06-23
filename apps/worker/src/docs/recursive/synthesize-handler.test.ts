import { docGenerations, docNodes, projects, type Db } from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { SYNTH_BODY_END_MARKER, SYNTH_BODY_START_MARKER } from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../../agent/fake.js";
import type { AgentRunUsage } from "../../agent/runner.js";
import { claimNextNode, type DocNode } from "../nodes.js";
import { runSynthesize, type RunSynthesizeDeps } from "./synthesize-handler.js";

// Test del handler di sintesi (M5.4): un nodo-ramo `ready_to_synthesize` con 2 figli
// `done`, reclamato via claimNextNode (→ `synthesizing`), e un FakeAgentRunner
// scriptato. Si asseriscono: overview valido scritto nel body + nodo done + join sul
// nonno; output di sintesi invalido → overview di fallback (figli non persi) → done.

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let projectId: string;
let generationId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  const { db } = testDb;
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: "Synth",
      slug: "synth",
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/synth",
      defaultBranch: "main",
      ingestionKey: "ingestion-synth",
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  projectId = project.id;
  const [generation] = await db.insert(docGenerations).values({ projectId }).returning();
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
  position?: number;
  title?: string;
  body?: string;
}

async function insertNode(db: Db, opts: InsertNodeOptions = {}): Promise<DocNode> {
  const { tree, ...rest } = opts;
  const [node] = await db
    .insert(docNodes)
    .values({ generationId, projectId, tree: tree ?? "technical", ...rest })
    .returning();
  if (!node) throw new Error("insert del nodo non ha restituito la riga");
  return node;
}

async function getNode(db: Db, id: string): Promise<DocNode> {
  const [node] = await db.select().from(docNodes).where(eq(docNodes.id, id));
  if (!node) throw new Error(`nodo ${id} non trovato`);
  return node;
}

/** Reclama il nodo ready_to_synthesize → synthesizing (ownership per l'handler). */
async function claim(db: Db): Promise<DocNode> {
  const claimed = await claimNextNode(db);
  if (!claimed) throw new Error("nessun nodo claimabile");
  return claimed.node;
}

const USAGE: AgentRunUsage = { totalCostUsd: 0.01, models: [] };

function baseDeps(db: Db, runner: FakeAgentRunner): RunSynthesizeDeps {
  return {
    db,
    runner,
    worktreeDir: "/tmp/fake-worktree",
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
  };
}

function synthOutput(body: string): string {
  return [SYNTH_BODY_START_MARKER, body, SYNTH_BODY_END_MARKER].join("\n");
}

/**
 * Prepara un nonno → nodo (ready_to_synthesize, con intro) → 2 figli done. Ritorna il
 * nodo dopo il claim (`synthesizing`) e l'id del nonno per asserire il join.
 */
async function seedTree(db: Db): Promise<{ node: DocNode; grandparentId: string }> {
  const grandparent = await insertNode(db, {
    title: "Grandparent",
    status: "awaiting_children",
    pendingChildren: 1,
    depth: 0,
  });
  const branch = await insertNode(db, {
    parentId: grandparent.id,
    title: "Area",
    status: "ready_to_synthesize",
    pendingChildren: 0,
    depth: 1,
    body: "### Intro\nQuesta area copre l'autenticazione e le sessioni utente.",
  });
  await insertNode(db, {
    parentId: branch.id,
    title: "Login",
    status: "done",
    depth: 2,
    position: 0,
    body: "### Login\nGli utenti accedono con email e password e ricevono una sessione.",
  });
  await insertNode(db, {
    parentId: branch.id,
    title: "Logout",
    status: "done",
    depth: 2,
    position: 1,
    body: "### Logout\nL'utente può terminare la sessione in qualsiasi momento.",
  });
  const node = await claim(db);
  expect(node.id).toBe(branch.id);
  return { node, grandparentId: grandparent.id };
}

describe("runSynthesize", () => {
  it("2 figli done → overview valido scritto nel body → nodo done → join sul nonno", async () => {
    const { db } = testDb;
    const { node, grandparentId } = await seedTree(db);

    const overview = "### Panoramica dell'area\nPresenta le sottoaree.\n\n### Login\nVai qui per accedere.\n\n### Logout\nVai qui per uscire.";
    const runner = new FakeAgentRunner({
      script: () => ({ output: synthOutput(overview), exitCode: 0, usage: USAGE }),
    });

    const result = await runSynthesize(baseDeps(db, runner), node);
    expect(result.outcome).toBe("synthesized");
    expect(result.costUsd).toBeCloseTo(0.01, 6);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    // Il prompt ha ricevuto i titoli dei figli da linkare.
    expect(runner.calls[0]?.prompt).toContain("Login");
    expect(runner.calls[0]?.prompt).toContain("Logout");

    const synthesized = await getNode(db, node.id);
    expect(synthesized.status).toBe("done");
    expect(synthesized.finishedAt).not.toBeNull();
    expect(synthesized.body).toContain("Panoramica dell'area");
    expect(synthesized.body).toContain("Login");
    expect(synthesized.body).toContain("Logout");

    // Join sul nonno: pendingChildren 1 → 0, ready_to_synthesize.
    const grandparent = await getNode(db, grandparentId);
    expect(grandparent.pendingChildren).toBe(0);
    expect(grandparent.status).toBe("ready_to_synthesize");
  });

  it("output di sintesi invalido → overview di fallback (figli non persi) → nodo done", async () => {
    const { db } = testDb;
    const { node, grandparentId } = await seedTree(db);

    const runner = new FakeAgentRunner({
      script: () => ({ output: "prosa libera senza marcatori del contratto", exitCode: 0, usage: USAGE }),
    });

    const result = await runSynthesize(baseDeps(db, runner), node);
    expect(result.outcome).toBe("fallback");
    // Retry: due invocazioni prima del fallback.
    expect(runner.calls).toHaveLength(2);

    const synthesized = await getNode(db, node.id);
    expect(synthesized.status).toBe("done");
    // Fallback: i figli sono comunque linkati (non persi) + l'intro dell'explore.
    expect(synthesized.body).toContain("Login");
    expect(synthesized.body).toContain("Logout");
    expect(synthesized.body).toContain("autenticazione");

    // Join sul nonno comunque avanzato.
    const grandparent = await getNode(db, grandparentId);
    expect(grandparent.pendingChildren).toBe(0);
    expect(grandparent.status).toBe("ready_to_synthesize");
  });
});
