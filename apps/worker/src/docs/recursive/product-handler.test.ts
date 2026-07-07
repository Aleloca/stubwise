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
  SECRETS_DETAIL_MARKER,
  SECRETS_VERDICT_MARKER,
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

/** Un fatto riservato pronto all'uso (per i test del verificatore segreti). */
const SECRET_FACT = {
  fact: "18% markup on every top-up",
  reason: "pricing strategy",
  source: "apps/admin/pricing.ts",
  avoid: "never state a percentage margin or wholesale price",
} as const;

/**
 * Brief con una superficie pubblica UI, una interna, un'API, + due journey esterni. Di
 * DEFAULT `confidentialFacts` è VUOTO: così il verificatore segreti (Fase C) è SALTATO
 * (fail-open dichiarato) e questi test restano identici al comportamento B3 (nessun run
 * audit). I test del verificatore passano `confidentialFacts: [SECRET_FACT]` esplicitamente.
 */
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
    confidentialFacts: [],
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

/**
 * Classifica un prompt (generazione product root/guide/faq, oppure verificatore segreti
 * audit/rewrite) dal suo contenuto testuale. `audit` = prompt del red-teamer; `rewrite` =
 * prompt della riscrittura mirata dopo una violazione.
 */
function promptKind(
  opts: AgentRunOptions,
): "root" | "guide" | "faq" | "audit" | "rewrite" | "other" {
  const p = opts.prompt;
  if (p.includes("You are a RED-TEAMER")) return "audit";
  if (p.includes("A confidentiality audit flagged a leak")) return "rewrite";
  if (p.includes("WRITE THE ROOT PAGE")) return "root";
  if (p.includes("WRITE A STEP-BY-STEP HOW-TO GUIDE")) return "guide";
  if (p.includes("WRITE THE FAQ PAGE")) return "faq";
  return "other";
}

/** Un output di audit `CLEAN` (nessuna violazione). */
function auditClean(): string {
  return [SECRETS_VERDICT_MARKER, "CLEAN", SECRETS_DETAIL_MARKER, ""].join("\n");
}

/** Un output di audit `VIOLATION` col detail (il passaggio incriminato). */
function auditViolation(detail = "Fact: 18% markup. Passage: 'a 18% margin is added'."): string {
  return [SECRETS_VERDICT_MARKER, "VIOLATION", SECRETS_DETAIL_MARKER, detail].join("\n");
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
    const generationId = await newGeneration(
      db,
      briefFixture({ confidentialFacts: [SECRET_FACT] }),
    );
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") return { output: auditClean(), exitCode: 0, usage: USAGE };
        const output = kind === "guide" ? validGuideBody() : validPageBody("P");
        return { output, exitCode: 0, usage: USAGE };
      },
    });
    await runProductPhase(baseDeps(db, runner), generationId);
    // Solo i prompt di GENERAZIONE (root/guide/faq): l'audit invece riceve di proposito i
    // fatti letterali (è il red-teamer) e va escluso da questa asserzione.
    const genCalls = runner.calls.filter((c) => promptKind(c) !== "audit" && promptKind(c) !== "rewrite");
    expect(genCalls.length).toBeGreaterThan(0);
    for (const call of genCalls) {
      expect(call.prompt).toContain("NEVER disclose");
      expect(call.prompt).toContain("never state a percentage margin");
      // Asserzione NEGATIVA end-to-end: il valore letterale riservato del brief (la
      // percentuale di markup) NON deve MAI comparire nel prompt di GENERAZIONE product.
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

  // ── FASE C — verificatore segreti fail-closed ─────────────────────────────────────────

  /**
   * Un brief con UN fatto riservato, UNA superficie pubblica e UN solo journey: root + 1
   * guida (la FAQ è saltata perché la fonte functional non ha heading di limitazione). Così
   * il conteggio dei run audit è deterministico (2 pagine × 1 audit ciascuna nel caso pulito).
   */
  function secretsBrief(): ProjectBrief {
    return briefFixture({
      confidentialFacts: [SECRET_FACT],
      journeys: [{ actor: "Customer", title: "Buy a top-up", summary: "purchase credit" }],
    });
  }

  it("pagina pulita: audit CLEAN → nodo creato (explore + audit)", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, secretsBrief());
    await insertFunctional(db, generationId, { sourcePaths: ["apps/web/x"] });

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") {
          auditRuns += 1;
          return { output: auditClean(), exitCode: 0, usage: USAGE };
        }
        const output = kind === "guide" ? validGuideBody() : validPageBody("P");
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    // root + 1 guida = 2 pagine, ciascuna con UN audit clean.
    expect(result.pagesCreated).toBe(2);
    expect(auditRuns).toBe(2);
    expect(result.productExclusions).toEqual([]);
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(2);
  });

  it("violazione → riscrittura → secondo audit CLEAN → nodo col body riscritto (4 run, nessuna esclusione)", async () => {
    const { db } = testDb;
    // Isolo la RADICE: un brief senza journey → solo la radice (no guide, no FAQ) così i 4
    // run (explore + audit(violation) + rewrite + audit(clean)) sono tutti e soli della radice.
    const generationId = await newGeneration(
      db,
      briefFixture({ confidentialFacts: [SECRET_FACT], journeys: [] }),
    );

    const rewrittenBody = validPageBody("Rewritten clean landing");
    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") {
          auditRuns += 1;
          // Primo audit → VIOLATION; secondo (sul body riscritto) → CLEAN.
          return {
            output: auditRuns === 1 ? auditViolation() : auditClean(),
            exitCode: 0,
            usage: USAGE,
          };
        }
        if (kind === "rewrite") return { output: rewrittenBody, exitCode: 0, usage: USAGE };
        return { output: validPageBody("Original with a 18% margin"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(1);
    expect(result.productExclusions).toEqual([]);
    // 4 run per la radice: explore + audit + rewrite + audit.
    expect(runner.calls.length).toBe(4);
    expect(auditRuns).toBe(2);
    // Il nodo porta il body RISCRITTO, non l'originale.
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.body).toContain("Rewritten clean landing");
    expect(nodes[0]?.body).not.toContain("Original with a 18% margin");
  });

  it("violazione persistente → pagina esclusa: stats.productExclusions con title+fact, nodo NON creato", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(
      db,
      briefFixture({ confidentialFacts: [SECRET_FACT], journeys: [] }),
    );

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        // L'audit boccia SEMPRE (anche dopo la riscrittura) → esclusione fail-closed.
        if (kind === "audit") {
          return { output: auditViolation("Fact: 18% markup leaked here"), exitCode: 0, usage: USAGE };
        }
        if (kind === "rewrite") return { output: validPageBody("Still leaky"), exitCode: 0, usage: USAGE };
        return { output: validPageBody("Root with a leak"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(0);
    expect(result.productExclusions.length).toBe(1);
    expect(result.productExclusions[0]?.title).toBe("Customer Web App guide");
    expect(result.productExclusions[0]?.fact).toContain("18% markup leaked here");
    // Nessun nodo product creato (la radice è stata esclusa → verticale scartata).
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(0);
  });

  it("confidentialFacts vuoto → nessun run audit (conteggio invariato rispetto a B3)", async () => {
    const { db } = testDb;
    // Default fixture: confidentialFacts vuoto → audit SALTATO (fail-open dichiarato).
    const generationId = await newGeneration(db, briefFixture({ journeys: [] }));

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        if (promptKind(opts) === "audit") auditRuns += 1;
        return { output: validPageBody("Root"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(1); // solo la radice (nessun journey)
    expect(auditRuns).toBe(0); // NESSUN audit senza fatti riservati
    // Un solo run: l'explore della radice (nessun audit) — invariato rispetto a B3.
    expect(runner.calls.length).toBe(1);
    expect(result.productExclusions).toEqual([]);
  });

  it("riscrittura non parsabile → pagina esclusa (fail-closed)", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(
      db,
      briefFixture({ confidentialFacts: [SECRET_FACT], journeys: [] }),
    );

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") {
          auditRuns += 1;
          return { output: auditViolation(), exitCode: 0, usage: USAGE };
        }
        // La riscrittura NON emette i marcatori ===PAGE=== → parseProductPageOutput fallisce.
        if (kind === "rewrite") return { output: "sorry, I cannot help with that", exitCode: 0, usage: USAGE };
        return { output: validPageBody("Root with a leak"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    expect(result.pagesCreated).toBe(0);
    expect(result.productExclusions.length).toBe(1);
    // Un solo audit: dopo la riscrittura non parsabile NON si ri-audita (fail-closed diretto).
    expect(auditRuns).toBe(1);
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(0);
  });

  it("audit che LANCIA (errore/limite) → pagina esclusa fail-closed, nodo NON creato", async () => {
    const { db } = testDb;
    // Un brief con la sola radice (nessun journey): il run audit sulla radice LANCIA. La
    // pipeline non deve pubblicare ciò che non ha potuto verificare → esclusione fail-closed.
    const generationId = await newGeneration(
      db,
      briefFixture({ confidentialFacts: [SECRET_FACT], journeys: [] }),
    );

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") {
          auditRuns += 1;
          throw new Error("boom: audit non eseguibile");
        }
        return { output: validPageBody("Root with a leak"), exitCode: 0, usage: USAGE };
      },
    });

    const result = await runProductPhase(baseDeps(db, runner), generationId);
    // La radice è esclusa (audit fallito) → verticale scartata, nessun nodo.
    expect(result.pagesCreated).toBe(0);
    expect(result.productExclusions.length).toBe(1);
    expect(result.productExclusions[0]?.title).toBe("Customer Web App guide");
    expect(result.productExclusions[0]?.fact).toContain("secrets audit failed");
    // Un solo tentativo di audit (che ha lanciato): nessuna riscrittura, nessun ri-audit.
    expect(auditRuns).toBe(1);
    const nodes = await productNodes(db, generationId);
    expect(nodes.length).toBe(0);
  });

  it("le esclusioni sopravvivono alla finalize: doc_generations.stats.productExclusions", async () => {
    const { db } = testDb;
    // Due superfici pubbliche: la PRIMA pulita (nodi creati), la SECONDA con violazione
    // persistente (esclusa). Così la generazione finalizza `succeeded` E porta l'esclusione.
    const brief = briefFixture({
      confidentialFacts: [SECRET_FACT],
      journeys: [{ actor: "Customer", title: "Buy a top-up", summary: "purchase credit" }],
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
    await insertFunctional(db, generationId, { sourcePaths: ["apps/web/x"] });
    await insertFunctional(db, generationId, { sourcePaths: ["apps/partner/y"] });

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        const kind = promptKind(opts);
        if (kind === "audit") {
          // La superficie "Partner Portal" perde: il suo body contiene il marcatore di leak.
          const isPartner = opts.prompt.includes("Partner Portal");
          return {
            output: isPartner ? auditViolation("partner leak") : auditClean(),
            exitCode: 0,
            usage: USAGE,
          };
        }
        if (kind === "rewrite") return { output: validPageBody("Still leaky partner"), exitCode: 0, usage: USAGE };
        const output = kind === "guide" ? validGuideBody() : validPageBody("Landing");
        return { output, exitCode: 0, usage: USAGE };
      },
    });

    const productResult = await runProductPhase(baseDeps(db, runner), generationId);
    expect(productResult.productExclusions.length).toBe(1);
    expect(productResult.productExclusions[0]?.title).toBe("Partner Portal guide");

    // La finalize riceve le esclusioni (come da node-dispatch) e le compone nelle stats.
    const outcome = await finalizeGeneration(
      { db, embeddingClient: createFakeEmbeddingClient() },
      generationId,
      productResult.productExclusions,
    );
    expect(outcome).toBe("succeeded");

    const [gen] = await db
      .select({ stats: docGenerations.stats })
      .from(docGenerations)
      .where(eq(docGenerations.id, generationId));
    const stats = gen?.stats as { productExclusions?: { title: string; fact: string }[] };
    expect(stats.productExclusions?.length).toBe(1);
    expect(stats.productExclusions?.[0]?.title).toBe("Partner Portal guide");
    expect(stats.productExclusions?.[0]?.fact).toContain("partner leak");
  });
});
