import {
  docChunks,
  docGenerations,
  docNodes,
  docPages,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  PRODUCT_PAGE_END_MARKER,
  PRODUCT_PAGE_START_MARKER,
  PRODUCT_SKIP_MARKER,
  type ProjectBrief,
} from "@stubwise/docs-engine";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../../agent/fake.js";
import type { AgentRunOptions, AgentRunResult } from "../../agent/runner.js";
import type { DocNode } from "../nodes.js";
import { finalizeGeneration } from "./finalize.js";
import { runProductPhase, type RunProductPhaseDeps } from "./product-handler.js";

// Test integrazione dell'handler product (Fase B): si semina una generazione con un brief
// (superfici + journey) e le pagine functional `done` come fonti, poi si esegue
// runProductPhase con un FakeAgentRunner scriptato a produrre radice / guide (con
// ancoraggi NAV) / FAQ / skip. Si asseriscono i nodi product creati (tree='product',
// done, parentId corretto, budget) e — per il caso completo — la finalize che li proietta
// in doc_pages kind='product' con chunks.

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let repositoryId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(docChunks);
  await testDb.db.delete(docPages);
  await testDb.db.delete(docNodes);
  await testDb.db.delete(docGenerations);
});

afterAll(async () => {
  await testDb.stop();
});

/** Brief con una superficie pubblica UI, una interna, un'API, + due journey esterni. */
function briefFixture(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    identity: "A top-up product for prepaid accounts.",
    actors: [
      { name: "Customer", description: "buys top-ups", internal: false },
      { name: "Operator", description: "runs the back office", internal: true },
    ],
    surfaces: [
      {
        name: "Customer Web App",
        type: "web app",
        rootPath: "apps/web",
        audience: "customers",
        internal: false,
      },
      {
        name: "Back Office",
        type: "admin app",
        rootPath: "apps/admin",
        audience: "operators",
        internal: true,
      },
    ],
    glossary: [{ term: "Top-up", definition: "adding credit to an account" }],
    invariants: ["A top-up always has an amount"],
    confidentialFacts: [
      {
        fact: "18% markup on every top-up",
        reason: "pricing strategy",
        source: "apps/admin/pricing.ts",
        avoid: "never state a percentage margin or wholesale price",
      },
    ],
    journeys: [
      { actor: "Customer", title: "Buy a top-up", summary: "purchase credit" },
      { actor: "Customer", title: "Check your balance", summary: "see remaining credit" },
    ],
    existingSources: [],
    ...overrides,
  };
}

async function newGeneration(db: Db, brief: ProjectBrief | null): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "running", model: "opus", brief })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  return gen.id;
}

interface InsertFnOptions {
  title?: string;
  body?: string;
  sourcePaths?: string[];
}

/** Inserisce un nodo functional `done` (fonte per summaries/limitations). */
async function insertFunctional(
  db: Db,
  generationId: string,
  opts: InsertFnOptions,
): Promise<DocNode> {
  const [node] = await db
    .insert(docNodes)
    .values({
      generationId,
      repositoryId,
      tree: "functional",
      status: "done",
      depth: 1,
      position: 0,
      title: opts.title ?? "Feature",
      slug: `fn-${Math.random().toString(36).slice(2, 8)}`,
      body: opts.body ?? "### Overview\nThis feature lets a customer do things in the app.",
      sourcePaths: opts.sourcePaths ?? [],
      finishedAt: new Date(),
    })
    .returning();
  if (!node) throw new Error("insert del nodo functional non ha restituito la riga");
  return node;
}

const USAGE = { totalCostUsd: 0.02, models: [] };

/** Un body di guida VALIDO: le 5 sezioni + due passi numerati con NAV in `### Steps`. */
function validGuideBody(): string {
  return [
    PRODUCT_PAGE_START_MARKER,
    "### Goal",
    "You want to add credit to your account.",
    "### Prerequisites",
    "You need an active account.",
    "### Steps",
    "1. Open the top-up form.",
    "   NAV: Top-ups → New top-up [/topups/new]",
    "2. Confirm the amount.",
    "   NAV: New top-up → Confirm [/topups/new]",
    "### Expected result",
    "Your balance increases.",
    "### Common issues",
    "If the payment fails, try again.",
    PRODUCT_PAGE_END_MARKER,
  ].join("\n");
}

/** Un body di guida SENZA ancoraggi NAV (fallirà la validazione → reason). */
function guideBodyNoNav(): string {
  return [
    PRODUCT_PAGE_START_MARKER,
    "### Goal",
    "You want to check your balance.",
    "### Prerequisites",
    "You need an active account.",
    "### Steps",
    "1. Look at the top of the screen.",
    "2. Read the number shown.",
    "### Expected result",
    "You see your balance.",
    "### Common issues",
    "None.",
    PRODUCT_PAGE_END_MARKER,
  ].join("\n");
}

/** Un body di pagina singola (radice / FAQ) valido. */
function validPageBody(label: string): string {
  return [
    PRODUCT_PAGE_START_MARKER,
    `### ${label}`,
    "This is a public, user-facing page written in the second person with enough prose to",
    "pass the minimum body length validation used across the documentation engine here.",
    PRODUCT_PAGE_END_MARKER,
  ].join("\n");
}

function baseDeps(
  db: Db,
  runner: FakeAgentRunner,
  overrides: Partial<RunProductPhaseDeps> = {},
): RunProductPhaseDeps {
  return {
    db,
    runner,
    worktreeDir: "/tmp/fake-worktree",
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
    maxProductPages: 12,
    ...overrides,
  };
}

/** Classifica un prompt product (root/guide/faq) dal suo contenuto testuale. */
function promptKind(opts: AgentRunOptions): "root" | "guide" | "faq" | "other" {
  const p = opts.prompt;
  if (p.includes("WRITE THE ROOT PAGE")) return "root";
  if (p.includes("WRITE A STEP-BY-STEP HOW-TO GUIDE")) return "guide";
  if (p.includes("WRITE THE FAQ PAGE")) return "faq";
  return "other";
}

async function productNodes(db: Db, generationId: string): Promise<DocNode[]> {
  return db
    .select()
    .from(docNodes)
    .where(and(eq(docNodes.generationId, generationId), eq(docNodes.tree, "product")));
}

describe("runProductPhase", () => {
  it("genera una verticale completa: radice + 2 guide + FAQ, nodi product done col parent giusto", async () => {
    const { db } = testDb;
    const brief = briefFixture();
    const generationId = await newGeneration(db, brief);
    // Fonte functional sotto apps/web con un heading di limitazione (per la FAQ).
    await insertFunctional(db, generationId, {
      title: "Top-up flow",
      sourcePaths: ["apps/web/topups"],
      body: [
        "### Overview",
        "The customer can buy top-ups from the web app.",
        "### Limitations",
        "You cannot cancel a top-up once confirmed.",
      ].join("\n"),
    });

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        const output =
          kind === "root"
            ? validPageBody("Getting started")
            : kind === "guide"
              ? validGuideBody()
              : kind === "faq"
                ? validPageBody("Frequently asked questions")
                : "";
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(4); // radice + 2 guide + FAQ

    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(4);
    const root = nodes.find((n) => n.parentId === null);
    expect(root).toBeDefined();
    expect(root?.depth).toBe(0);
    expect(root?.status).toBe("done");
    expect((root?.body ?? "").length).toBeGreaterThan(0);
    // Le 3 figlie (2 guide + FAQ) hanno la radice come parent.
    const children = nodes.filter((n) => n.parentId === root!.id);
    expect(children.length).toBe(3);
    expect(children.every((c) => c.depth === 1 && c.status === "done")).toBe(true);
  });

  it("una guida che risponde ===SKIP=== non produce quella pagina, il resto della verticale sì", async () => {
    const { db } = testDb;
    const brief = briefFixture();
    const generationId = await newGeneration(db, brief);
    await insertFunctional(db, generationId, {
      sourcePaths: ["apps/web/topups"],
      body: "### Overview\nWeb app feature.\n### Cannot do\nYou cannot delete history.",
    });

    let guideCall = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "guide") {
          guideCall += 1;
          // La prima guida è realizzabile; la seconda l'agente la SALTA.
          const output =
            guideCall === 1
              ? validGuideBody()
              : `${PRODUCT_SKIP_MARKER}\nthis journey belongs to another surface`;
          return { output, exitCode: 0, usage: USAGE };
        }
        const output =
          kind === "root" ? validPageBody("Root") : kind === "faq" ? validPageBody("FAQ") : "";
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    // radice + 1 guida (l'altra skippata) + FAQ = 3.
    expect(result.pagesCreated).toBe(3);
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(3);
  });

  it("una guida senza ancoraggi di navigazione viene ritentata una volta e poi scartata (2 run)", async () => {
    const { db } = testDb;
    // Un solo journey per isolare il conteggio dei run della guida.
    const brief = briefFixture({
      journeys: [{ actor: "Customer", title: "Check your balance", summary: "see credit" }],
    });
    const generationId = await newGeneration(db, brief);
    await insertFunctional(db, generationId, { sourcePaths: ["apps/web/x"] });

    let guideRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "guide") {
          guideRuns += 1;
          return { output: guideBodyNoNav(), exitCode: 0, usage: USAGE };
        }
        return { output: validPageBody("P"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    // La guida ha girato DUE volte (run + retry) ed è stata scartata: restano radice + FAQ.
    expect(guideRuns).toBe(2);
    const nodes = await productNodes(db, generationId);
    const titles = nodes.map((n) => n.title);
    expect(titles).not.toContain("Check your balance");
    // radice + FAQ (la limitation dal body di default non c'è → FAQ potrebbe saltare):
    // la radice c'è di sicuro.
    expect(nodes.some((n) => n.parentId === null)).toBe(true);
    expect(result.pagesCreated).toBeGreaterThanOrEqual(1);
  });

  it("una superficie di tipo API pubblica è esclusa: nessun run product per essa", async () => {
    const { db } = testDb;
    const brief = briefFixture({
      surfaces: [
        {
          name: "Public API",
          type: "REST API",
          rootPath: "apps/server",
          audience: "integrators",
          internal: false,
        },
      ],
    });
    const generationId = await newGeneration(db, brief);

    const runner = new FakeAgentRunner({
      script: (): AgentRunResult => ({ output: validPageBody("X"), exitCode: 0, usage: USAGE }),
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(0);
    expect(runner.calls.length).toBe(0); // nessun run
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(0);
  });

  it("brief assente → fase saltata, nessun nodo product, nessun run", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, null);
    const runner = new FakeAgentRunner({
      script: (): AgentRunResult => ({ output: validPageBody("X"), exitCode: 0, usage: USAGE }),
    });
    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(0);
    expect(runner.calls.length).toBe(0);
  });

  it("maxProductPages=0 → fase saltata anche con brief e superfici valide", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, briefFixture());
    const runner = new FakeAgentRunner({
      script: (): AgentRunResult => ({ output: validPageBody("X"), exitCode: 0, usage: USAGE }),
    });
    const result = await runProductPhase(
      baseDeps(db, runner, { maxProductPages: 0 }),
      generationId,
    );
    expect(result.pagesCreated).toBe(0);
    expect(runner.calls.length).toBe(0);
  });

  it("budget PER VERTICALE: tetto 2 con 3 pagine potenziali nella STESSA verticale → solo 2 create", async () => {
    const { db } = testDb;
    // Una sola superficie pubblica → una sola verticale: il tetto per verticale (2) taglia
    // la terza pagina potenziale (radice + 1 guida = 2, poi stop) esattamente come un tetto
    // totale, perché qui c'è una sola verticale.
    const brief = briefFixture();
    const generationId = await newGeneration(db, brief);
    await insertFunctional(db, generationId, { sourcePaths: ["apps/web/x"] });

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        const output =
          kind === "guide" ? validGuideBody() : validPageBody("P");
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(
      baseDeps(db, runner, { maxProductPages: 2 }),
      generationId,
    );
    expect(result.pagesCreated).toBe(2); // radice + 1 guida, poi stop
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(2);
  });

  it("budget PER VERTICALE: 2 superfici con tetto 2 → ciascuna fino a 2, la seconda NON affamata", async () => {
    const { db } = testDb;
    // Due superfici pubbliche UI eleggibili → due verticali. Col budget PER VERTICALE
    // ciascuna riparte col suo tetto (2): la seconda superficie NON resta a zero (come
    // sarebbe stato con un tetto TOTALE, esaurito già dalla prima verticale).
    const brief = briefFixture({
      surfaces: [
        {
          name: "Customer Web App",
          type: "web app",
          rootPath: "apps/web",
          audience: "customers",
          internal: false,
        },
        {
          name: "Partner Portal",
          type: "web app",
          rootPath: "apps/partner",
          audience: "partners",
          internal: false,
        },
      ],
    });
    const generationId = await newGeneration(db, brief);
    // Una fonte functional per ciascuna superficie (per abilitare guide/summaries).
    await insertFunctional(db, generationId, { sourcePaths: ["apps/web/x"] });
    await insertFunctional(db, generationId, { sourcePaths: ["apps/partner/y"] });

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        const output = kind === "guide" ? validGuideBody() : validPageBody("P");
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(
      baseDeps(db, runner, { maxProductPages: 2 }),
      generationId,
    );
    // 2 verticali × 2 pagine (radice + 1 guida ciascuna) = 4 totali.
    expect(result.pagesCreated).toBe(4);
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(4);
    // Due radici (una per superficie): la SECONDA verticale è stata prodotta (non affamata).
    const roots = nodes.filter((n) => n.parentId === null);
    expect(roots.length).toBe(2);
  });

  it("il prompt product contiene la sezione NEVER-disclose dei segreti del brief", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, briefFixture());
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        const output = kind === "guide" ? validGuideBody() : validPageBody("P");
        return { output, exitCode: 0, usage: USAGE };
      },
    });
    await runProductPhase(baseDeps(db, runner), generationId);
    // Ogni run product deve portare la sezione NEVER-disclose col divieto categorico.
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.prompt).toContain("NEVER disclose");
      expect(call.prompt).toContain("never state a percentage margin");
      // Asserzione NEGATIVA end-to-end: il valore letterale riservato del brief (la
      // percentuale di markup) NON deve MAI comparire nel prompt product.
      expect(call.prompt).not.toContain("18%");
    }
  });

  it("i nodi product entrano nella finalize: doc_pages kind='product' con chunks", async () => {
    const { db } = testDb;
    const brief = briefFixture({
      journeys: [{ actor: "Customer", title: "Buy a top-up", summary: "purchase credit" }],
    });
    const generationId = await newGeneration(db, brief);
    await insertFunctional(db, generationId, {
      title: "Top-up flow",
      sourcePaths: ["apps/web/topups"],
      body: [
        "### Overview",
        "The customer buys top-ups from the web app with a clear flow and confirmation.",
        "### Limitations",
        "You cannot cancel a top-up once it is confirmed.",
      ].join("\n"),
    });

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        const output =
          kind === "guide" ? validGuideBody() : validPageBody("Landing content");
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    await runProductPhase(baseDeps(db, runner), generationId);

    // I nodi product sono `done`: la finalize li proietta come gli altri.
    const outcome = await finalizeGeneration(
      { db, embeddingClient: createFakeEmbeddingClient() },
      generationId,
    );
    expect(outcome).toBe("succeeded");

    const productPages = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId), eq(docPages.kind, "product")));
    // radice + 1 guida + FAQ = 3 pagine product.
    expect(productPages.length).toBe(3);
    // La radice è genitore delle altre due nelle doc_pages.
    const pageRoot = productPages.find((p) => p.parentId === null);
    expect(pageRoot).toBeDefined();
    const childPages = productPages.filter((p) => p.parentId === pageRoot!.id);
    expect(childPages.length).toBe(2);

    // Chunks embeddati per le pagine product.
    const pageIds = new Set(productPages.map((p) => p.id));
    const chunks = await db
      .select()
      .from(docChunks)
      .where(eq(docChunks.generationId, generationId));
    expect(chunks.some((c) => pageIds.has(c.pageId))).toBe(true);
  });
});
