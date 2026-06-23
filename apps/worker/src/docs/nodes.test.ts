import { docGenerations, docNodes, projects, type Db } from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  claimNextNode,
  completeNode,
  createChildren,
  failNode,
  requeueStaleNodes,
  touchNode,
  writeExploreResult,
  type ChildSpec,
  type DocNode,
} from "./nodes.js";

// Un container Postgres per file di test. I test si isolano svuotando doc_nodes
// in afterEach (claimNextNode è globale: prende il nodo claimabile più vecchio
// dell'intera tabella).
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
      name: "Nodi",
      slug: "nodi",
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/nodi",
      defaultBranch: "main",
      ingestionKey: "ingestion-nodi",
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

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

interface InsertNodeOptions {
  parentId?: string;
  tree?: DocNode["tree"];
  status?: DocNode["status"];
  pendingChildren?: number;
  depth?: number;
  createdAt?: Date;
  lastActivityAt?: Date;
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

describe("claimNextNode", () => {
  it("porta il nodo pending più vecchio a exploring (fase explore)", async () => {
    const { db } = testDb;
    const oldest = await insertNode(db, { createdAt: minutesAgo(3) });
    await insertNode(db, { createdAt: minutesAgo(1) });

    const claimed = await claimNextNode(db);

    expect(claimed?.node.id).toBe(oldest.id);
    expect(claimed?.phase).toBe("explore");
    expect(claimed?.node.status).toBe("exploring");
    expect(claimed?.node.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    expect((await getNode(db, oldest.id)).status).toBe("exploring");
  });

  it("porta un nodo ready_to_synthesize a synthesizing (fase synthesize)", async () => {
    const { db } = testDb;
    const node = await insertNode(db, { status: "ready_to_synthesize" });

    const claimed = await claimNextNode(db);

    expect(claimed?.node.id).toBe(node.id);
    expect(claimed?.phase).toBe("synthesize");
    expect(claimed?.node.status).toBe("synthesizing");
  });

  it("reclama oldest-first tra nodi claimabili di stati misti", async () => {
    const { db } = testDb;
    const oldest = await insertNode(db, {
      status: "ready_to_synthesize",
      createdAt: minutesAgo(5),
    });
    await insertNode(db, { status: "pending", createdAt: minutesAgo(2) });

    const claimed = await claimNextNode(db);
    expect(claimed?.node.id).toBe(oldest.id);
    expect(claimed?.phase).toBe("synthesize");
  });

  it("restituisce null se non ci sono nodi claimabili", async () => {
    const { db } = testDb;
    expect(await claimNextNode(db)).toBeNull();

    // Stati non claimabili: nessuno viene preso.
    await insertNode(db, { status: "exploring" });
    await insertNode(db, { status: "awaiting_children" });
    await insertNode(db, { status: "done" });
    expect(await claimNextNode(db)).toBeNull();
  });

  it("claim concorrenti non prendono mai lo stesso nodo", async () => {
    const { db } = testDb;
    await insertNode(db, { createdAt: minutesAgo(3) });
    await insertNode(db, { createdAt: minutesAgo(2) });
    await insertNode(db, { createdAt: minutesAgo(1) });

    const results = await Promise.all([
      claimNextNode(db),
      claimNextNode(db),
      claimNextNode(db),
      claimNextNode(db),
      claimNextNode(db),
    ]);

    const claimed = results.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((r) => r.node.id)).size).toBe(3);
  });
});

describe("writeExploreResult", () => {
  it("scrive body e sourcePaths su un nodo exploring", async () => {
    const { db } = testDb;
    const node = await insertNode(db, { status: "exploring" });

    const ok = await writeExploreResult(db, node.id, {
      body: "# Modulo\n\ndescrizione",
      sourcePaths: ["src/a.ts", "src/b.ts"],
    });

    expect(ok).toBe(true);
    const persisted = await getNode(db, node.id);
    expect(persisted.body).toContain("# Modulo");
    expect(persisted.sourcePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("restituisce false e non scrive se il nodo non è più exploring (ownership persa)", async () => {
    const { db } = testDb;
    const node = await insertNode(db, { status: "pending" });

    const ok = await writeExploreResult(db, node.id, { body: "tardivo", sourcePaths: [] });

    expect(ok).toBe(false);
    expect((await getNode(db, node.id)).body).toBe("");
  });
});

describe("createChildren", () => {
  it("inserisce N figli pending (depth+1) e arma il join sul padre", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "exploring", depth: 1 });

    const specs: ChildSpec[] = [
      { tree: "technical", title: "uno", unitRef: "src/uno" },
      { tree: "technical", title: "due", unitRef: "src/due" },
    ];
    await createChildren(db, parent.id, specs);

    const persistedParent = await getNode(db, parent.id);
    expect(persistedParent.status).toBe("awaiting_children");
    expect(persistedParent.pendingChildren).toBe(2);

    const children = await db.select().from(docNodes).where(eq(docNodes.parentId, parent.id));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.status).toBe("pending");
      expect(child.depth).toBe(2);
      expect(child.generationId).toBe(parent.generationId);
      expect(child.projectId).toBe(parent.projectId);
    }
    expect(new Set(children.map((c) => c.position))).toEqual(new Set([0, 1]));
  });

  it("rifiuta una lista vuota (una foglia usa completeNode)", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "exploring" });
    await expect(createChildren(db, parent.id, [])).rejects.toThrow(/foglia/);
  });
});

describe("completeNode / failNode", () => {
  it("completeNode su una foglia senza padre la porta a done", async () => {
    const { db } = testDb;
    const leaf = await insertNode(db, { status: "exploring" });

    const ok = await completeNode(db, leaf.id);

    expect(ok).toBe(true);
    const persisted = await getNode(db, leaf.id);
    expect(persisted.status).toBe("done");
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("completeNode su un figlio decrementa il join del padre", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 2 });
    const child = await insertNode(db, { status: "exploring", parentId: parent.id });

    expect(await completeNode(db, child.id)).toBe(true);

    const persistedParent = await getNode(db, parent.id);
    expect(persistedParent.pendingChildren).toBe(1);
    // Ancora un figlio in volo: il padre resta in attesa.
    expect(persistedParent.status).toBe("awaiting_children");
  });

  it("l'ultimo figlio che si chiude flippa il padre a ready_to_synthesize", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 1 });
    const child = await insertNode(db, { status: "synthesizing", parentId: parent.id });

    await completeNode(db, child.id);

    const persistedParent = await getNode(db, parent.id);
    expect(persistedParent.pendingChildren).toBe(0);
    expect(persistedParent.status).toBe("ready_to_synthesize");
  });

  it("failNode fa comunque avanzare il join del padre (niente deadlock)", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 1 });
    const child = await insertNode(db, { status: "exploring", parentId: parent.id });

    expect(await failNode(db, child.id, "explore fallito")).toBe(true);

    const persistedChild = await getNode(db, child.id);
    expect(persistedChild.status).toBe("failed");
    expect(persistedChild.error).toBe("explore fallito");

    const persistedParent = await getNode(db, parent.id);
    expect(persistedParent.pendingChildren).toBe(0);
    expect(persistedParent.status).toBe("ready_to_synthesize");
  });

  it("una transizione su un nodo non in lavorazione restituisce false e non tocca il padre", async () => {
    const { db } = testDb;
    const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 2 });
    const child = await insertNode(db, { status: "pending", parentId: parent.id });

    expect(await completeNode(db, child.id)).toBe(false);
    expect(await failNode(db, child.id, "boom")).toBe(false);

    expect((await getNode(db, child.id)).status).toBe("pending");
    // Il contatore del padre NON è stato toccato.
    expect((await getNode(db, parent.id)).pendingChildren).toBe(2);
  });
});

describe("join atomico — race test", () => {
  it("3 figli completati in parallelo flippano il padre ESATTAMENTE una volta", async () => {
    const { db } = testDb;
    // Ripeto più volte per stanare un eventuale flake da race condition.
    for (let round = 0; round < 5; round++) {
      const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 3 });
      const children = await Promise.all([
        insertNode(db, { status: "exploring", parentId: parent.id }),
        insertNode(db, { status: "exploring", parentId: parent.id }),
        insertNode(db, { status: "synthesizing", parentId: parent.id }),
      ]);

      const results = await Promise.all(children.map((c) => completeNode(db, c.id)));
      // Tutte e tre le transizioni vanno a buon fine (status-guard distinto per nodo).
      expect(results).toEqual([true, true, true]);

      const persistedParent = await getNode(db, parent.id);
      expect(persistedParent.pendingChildren).toBe(0);
      expect(persistedParent.status).toBe("ready_to_synthesize");

      await db.delete(docNodes);
    }
  });

  it("mix 2 complete + 1 fail in parallelo: il padre raggiunge comunque ready_to_synthesize", async () => {
    const { db } = testDb;
    for (let round = 0; round < 5; round++) {
      const parent = await insertNode(db, { status: "awaiting_children", pendingChildren: 3 });
      const children = await Promise.all([
        insertNode(db, { status: "exploring", parentId: parent.id }),
        insertNode(db, { status: "exploring", parentId: parent.id }),
        insertNode(db, { status: "synthesizing", parentId: parent.id }),
      ]);

      await Promise.all([
        completeNode(db, children[0]!.id),
        failNode(db, children[1]!.id, "boom"),
        completeNode(db, children[2]!.id),
      ]);

      const persistedParent = await getNode(db, parent.id);
      expect(persistedParent.pendingChildren).toBe(0);
      expect(persistedParent.status).toBe("ready_to_synthesize");

      await db.delete(docNodes);
    }
  });
});

describe("requeueStaleNodes", () => {
  it("ripristina solo i nodi exploring/synthesizing fermi oltre la soglia, allo stato claimabile giusto", async () => {
    const { db } = testDb;
    const staleExplore = await insertNode(db, {
      status: "exploring",
      lastActivityAt: minutesAgo(30),
    });
    const staleSynth = await insertNode(db, {
      status: "synthesizing",
      lastActivityAt: minutesAgo(30),
    });
    const freshExplore = await insertNode(db, {
      status: "exploring",
      lastActivityAt: minutesAgo(2),
    });
    const pending = await insertNode(db, { status: "pending", lastActivityAt: minutesAgo(60) });
    const awaiting = await insertNode(db, {
      status: "awaiting_children",
      lastActivityAt: minutesAgo(60),
    });

    const requeued = await requeueStaleNodes(db, 10);

    expect(requeued).toBe(2);
    expect((await getNode(db, staleExplore.id)).status).toBe("pending");
    expect((await getNode(db, staleSynth.id)).status).toBe("ready_to_synthesize");
    // finishedAt resta null: il nodo non è concluso, solo riportato in coda.
    expect((await getNode(db, staleExplore.id)).finishedAt).toBeNull();
    expect((await getNode(db, freshExplore.id)).status).toBe("exploring");
    expect((await getNode(db, pending.id)).status).toBe("pending");
    expect((await getNode(db, awaiting.id)).status).toBe("awaiting_children");
  });

  it("un heartbeat touchNode recente tiene il nodo fuori dal requeue oltre la soglia", async () => {
    const { db } = testDb;
    const longRunning = await insertNode(db, {
      status: "exploring",
      lastActivityAt: minutesAgo(120),
    });
    await touchNode(db, longRunning.id);

    expect(await requeueStaleNodes(db, 10)).toBe(0);
    expect((await getNode(db, longRunning.id)).status).toBe("exploring");
  });
});
