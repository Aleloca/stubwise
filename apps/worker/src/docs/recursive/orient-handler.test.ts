import {
  aiProviders,
  docGenerationJobs,
  docGenerations,
  docNodes,
  encrypt,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  BRIEF_ACTORS_END_MARKER,
  BRIEF_ACTORS_START_MARKER,
  BRIEF_CONFIDENTIAL_END_MARKER,
  BRIEF_CONFIDENTIAL_START_MARKER,
  BRIEF_GLOSSARY_END_MARKER,
  BRIEF_GLOSSARY_START_MARKER,
  BRIEF_IDENTITY_END_MARKER,
  BRIEF_IDENTITY_START_MARKER,
  BRIEF_INVARIANTS_END_MARKER,
  BRIEF_INVARIANTS_START_MARKER,
  BRIEF_JOURNEYS_END_MARKER,
  BRIEF_JOURNEYS_START_MARKER,
  BRIEF_SOURCES_END_MARKER,
  BRIEF_SOURCES_START_MARKER,
  BRIEF_SURFACES_END_MARKER,
  BRIEF_SURFACES_START_MARKER,
  ORIENT_END_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
} from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../../agent/fake.js";
import type { AgentRunUsage } from "../../agent/runner.js";
import { MirrorManager } from "../../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS } from "../../graph/agent-hint.js";
import { type DocJob } from "../queue.js";
import { runOrientation, type RunOrientationDeps } from "./orient-handler.js";
import { createGenerationWorktreeRegistry } from "./registry.js";

// Test del handler di orientamento (M5.2): mirror bare locale come "upstream", un
// FakeAgentRunner scriptato a produrre un piano marcato (===ORIENTATION PLAN=== con
// 2 unità tecniche + 2 capability funzionali) e un fake embedding non serve (no
// embed in orientamento). Si asseriscono: generazione running + 2 radici
// (awaiting_children, pendingChildren=2) + 4 figli pending depth 1; output invalido
// → retry → fail (generazione failed, trigger failed).

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

async function makeUpstream(): Promise<{ url: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-orient-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "demo" }) + "\n");
  await writeFile(join(work, "index.ts"), "export function hello() { return 'hi'; }\n");
  await git(["add", "."], work);
  await git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"],
    work,
  );
  await git(["push", "origin", "main"], work);
  return { url: pathToFileURL(dir).href };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-orient-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

// Crea un progetto (gruppo) + un repository che vi appartiene e ritorna il
// repositoryId (la documentazione è per repository). Il provider AI del progetto
// resta null (automatico) salvo override esplicito nel progetto altrove.
async function createRepository(db: Db, repoUrl: string): Promise<string> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    provider: "github",
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  const [project] = await db
    .insert(projects)
    .values({ name: `Gruppo ${uniq}`, slug: `gruppo-${uniq}`, ingestionKey: `ingestion-docs-${uniq}` })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project.id,
      name: `Docs ${uniq}`,
      slug: `docs-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
    })
    .returning();
  if (!repository) throw new Error("insert del repository non ha restituito la riga");
  return repository.id;
}

async function enqueueTrigger(db: Db, repositoryId: string): Promise<DocJob> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ repositoryId, status: "running", startedAt: new Date() })
    .returning();
  if (!job) throw new Error("insert del trigger non ha restituito la riga");
  return job;
}

/** Piano di orientamento ben formato: 2 unità tecniche + 2 capability funzionali. */
const VALID_PLAN = [
  ORIENT_START_MARKER,
  "Detected a TypeScript project. plans/ is context-noise, src/ is architecture.",
  ORIENT_TECHNICAL_START_MARKER,
  "- Core Module :: src/core :: il cuore del sistema",
  "- API Layer :: src/api :: gli endpoint HTTP",
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  "- Greet Users :: src/core :: saluta gli utenti",
  "- Serve Requests :: src/api :: risponde alle richieste",
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_END_MARKER,
].join("\n");

/** Output ben formato del "documentarista": brief valido (campi a campione). */
const VALID_BRIEF = [
  BRIEF_IDENTITY_START_MARKER,
  "Un marketplace demo: i clienti comprano, i venditori vendono.",
  BRIEF_IDENTITY_END_MARKER,
  BRIEF_ACTORS_START_MARKER,
  "Cliente :: compra prodotti :: false",
  "Operatore :: gestisce il back office :: true",
  BRIEF_ACTORS_END_MARKER,
  BRIEF_SURFACES_START_MARKER,
  "Storefront :: web :: src/api :: clienti :: false",
  "Admin :: web :: src/core :: staff :: true",
  BRIEF_SURFACES_END_MARKER,
  BRIEF_GLOSSARY_START_MARKER,
  "Ordine :: una richiesta d'acquisto confermata",
  "Wallet :: saldo prepagato del cliente",
  BRIEF_GLOSSARY_END_MARKER,
  BRIEF_INVARIANTS_START_MARKER,
  "Un ordine ha sempre almeno una riga",
  BRIEF_INVARIANTS_END_MARKER,
  BRIEF_CONFIDENTIAL_START_MARKER,
  "markup del fornitore :: economico :: src/core :: mai citare percentuali di margine",
  BRIEF_CONFIDENTIAL_END_MARKER,
  BRIEF_JOURNEYS_START_MARKER,
  "Cliente :: Comprare :: sceglie un prodotto e paga col wallet",
  BRIEF_JOURNEYS_END_MARKER,
  BRIEF_SOURCES_START_MARKER,
  "README.md",
  BRIEF_SOURCES_END_MARKER,
].join("\n");

const USAGE: AgentRunUsage = { totalCostUsd: 0.02, models: [] };

/**
 * L'orientamento fa DUE run in sequenza: PRIMA il project brief (prompt del
 * "documentarista"), POI l'orientamento vero e proprio (prompt con i marcatori del
 * PIANO). Questo script instrada per contenuto del prompt: `briefOut` alla prima
 * chiamata (prompt del brief), `orientOut` alla seconda (prompt di orientamento).
 */
function scriptBriefThenOrient(
  briefOut: string,
  orientOut: string,
): (opts: { prompt: string }) => { output: string; exitCode: number; usage: AgentRunUsage } {
  return (opts) => {
    const isOrient = opts.prompt.includes(ORIENT_START_MARKER);
    return { output: isOrient ? orientOut : briefOut, exitCode: 0, usage: USAGE };
  };
}

function baseDeps(db: Db, mirrors: MirrorManager, runner: FakeAgentRunner): RunOrientationDeps {
  return {
    db,
    mirrors,
    runner,
    encryptionKey: ENCRYPTION_KEY,
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
  };
}

describe("runOrientation", () => {
  it("semina due radici (awaiting_children, pendingChildren=2) + 4 figli pending depth 1", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    const runner = new FakeAgentRunner({
      script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("seeded");

    // DUE run read-only col modello giusto: brief (step 1) poi orientamento (step 2).
    expect(runner.calls).toHaveLength(2);
    for (const call of runner.calls) {
      expect(call.permissionMode).toBe("plan");
      expect(call.model).toBe("opus");
    }
    // Il primo run è il brief del "documentarista"; il secondo è l'orientamento.
    const briefCall = runner.calls[0];
    const orientCall = runner.calls[1];
    expect(briefCall?.prompt.toLowerCase()).toContain("documentarian");
    // Il survey è arrivato nel prompt di orientamento (manifest letto).
    expect(orientCall?.prompt).toContain("package.json");
    // Il contesto del brief (glossario) è iniettato nel prompt di orientamento.
    expect(orientCall?.prompt).toContain("PROJECT CONTEXT");
    expect(orientCall?.prompt).toContain("Ordine");

    // Generazione running + commitSha + brief persistito + costo aggregato (brief+orient).
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.status).toBe("running");
    expect(gen?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // Costo = run brief (0.02) + run orient (0.02) = 0.04.
    expect(Number(gen?.cost)).toBeCloseTo(0.04, 6);

    // Il brief è persistito su doc_generations.brief (campi a campione, admin escluso? no:
    // il brief conserva TUTTE le superfici; l'esclusione delle interne è a valle, Fase B).
    const persistedBrief = gen?.brief as {
      identity: string;
      glossary: { term: string }[];
      surfaces: { name: string; internal: boolean }[];
      confidentialFacts: { fact: string }[];
    } | null;
    expect(persistedBrief).not.toBeNull();
    expect(persistedBrief?.identity).toContain("marketplace");
    expect(persistedBrief?.glossary.map((g) => g.term)).toContain("Ordine");
    expect(persistedBrief?.surfaces.find((s) => s.name === "Admin")?.internal).toBe(true);
    expect(persistedBrief?.confidentialFacts).toHaveLength(1);

    // Due radici, depth 0, parentId null, awaiting_children, pendingChildren=2.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    const roots = nodes.filter((n) => n.parentId === null);
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(root.depth).toBe(0);
      expect(root.status).toBe("awaiting_children");
      expect(root.pendingChildren).toBe(2);
    }
    const techRoot = roots.find((r) => r.tree === "technical");
    const funcRoot = roots.find((r) => r.tree === "functional");
    expect(techRoot?.title).toBe("Architecture Overview");
    expect(funcRoot?.title).toBe("Capability Map");

    // Quattro figli pending, depth 1, slug/tree/title/unitRef corretti.
    const children = nodes.filter((n) => n.parentId !== null);
    expect(children).toHaveLength(4);
    for (const child of children) {
      expect(child.depth).toBe(1);
      expect(child.status).toBe("pending");
      expect(child.slug.length).toBeGreaterThan(0);
    }
    const techChildren = children.filter((c) => c.parentId === techRoot!.id);
    expect(techChildren.map((c) => c.title).sort()).toEqual(["API Layer", "Core Module"]);
    const coreModule = techChildren.find((c) => c.title === "Core Module");
    expect(coreModule?.tree).toBe("technical");
    expect(coreModule?.unitRef).toBe("src/core");
    expect(coreModule?.sourcePaths).toEqual(["src/core"]);

    const funcChildren = children.filter((c) => c.parentId === funcRoot!.id);
    expect(funcChildren.map((c) => c.title).sort()).toEqual(["Greet Users", "Serve Requests"]);
    expect(funcChildren.every((c) => c.tree === "functional")).toBe(true);

    // Slug univoci tra TUTTI i nodi (radici + figli).
    const slugs = nodes.map((n) => n.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    // Il trigger è CHIUSO `succeeded` al seed del DAG (decoupling C2), con generationId
    // collegato: lo stato "generazione in corso" vive ora su doc_generations.
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("succeeded");
    expect(jobAfter?.generationId).toBe(gen!.id);
  });

  // ── Knowledge graph (fase 2c): mappa nel prompt + allowlist, SOLO col grafo ────────
  describe("grafo del repository (fase 2c)", () => {
    /** Scrive un graph.json plausibile per `repositoryId` sotto `graphsDir`. */
    async function seedGraph(graphsDir: string, repositoryId: string): Promise<void> {
      const outDir = join(graphsDir, repositoryId, "graphify-out");
      await mkdir(outDir, { recursive: true });
      const nodes = [
        {
          id: "hub",
          label: "buildApp()",
          source_file: "src/core/app.ts",
          community: 1,
          community_name: "Core runtime",
        },
      ];
      const links: { source: string; target: string }[] = [];
      for (let i = 1; i <= 12; i++) {
        nodes.push({
          id: `r${i}`,
          label: `route${i}()`,
          source_file: `src/api/route${i}.ts`,
          community: 2,
          community_name: "HTTP API",
        });
        links.push({ source: "hub", target: `r${i}` });
      }
      await writeFile(join(outDir, "graph.json"), JSON.stringify({ nodes, links }));
    }

    async function makeGraphsDir(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "stubwise-orient-graphs-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      return dir;
    }

    it("col grafo: mappa nel prompt di orientamento, hint nel brief, allowlist graphify su entrambi i run", async () => {
      const { db } = testDb;
      const upstream = await makeUpstream();
      const mirrors = await makeMirrors();
      const repositoryId = await createRepository(db, upstream.url);
      const graphsDir = await makeGraphsDir();
      await seedGraph(graphsDir, repositoryId);
      const job = await enqueueTrigger(db, repositoryId);

      const runner = new FakeAgentRunner({
        script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
      });
      const outcome = await runOrientation(
        { ...baseDeps(db, mirrors, runner), graphsDir },
        job,
      );
      expect(outcome).toBe("seeded");
      expect(runner.calls).toHaveLength(2);

      const briefCall = runner.calls[0];
      const orientCall = runner.calls[1];
      const graphJson = join(graphsDir, repositoryId, "graphify-out", "graph.json");

      // ORIENTAMENTO: la MAPPA (comunità + god node) + i comandi di interrogazione.
      expect(orientCall?.prompt).toContain("CODE GRAPH MAP");
      expect(orientCall?.prompt).toContain("HTTP API");
      expect(orientCall?.prompt).toContain("buildApp()");
      expect(orientCall?.prompt).toContain(graphJson);
      // Presentata come IPOTESI da verificare, dopo il survey.
      expect(orientCall?.prompt.toLowerCase()).toContain("hypothesis");
      expect(orientCall!.prompt.indexOf("REPOSITORY SURVEY:")).toBeLessThan(
        orientCall!.prompt.indexOf("CODE GRAPH MAP"),
      );

      // BRIEF: solo i comandi del grafo (niente mappa intera: il documentarista esplora).
      expect(briefCall?.prompt).toContain("graphify query");
      expect(briefCall?.prompt).toContain(graphJson);
      expect(briefCall?.prompt).not.toContain("CODE GRAPH MAP");

      // Allowlist read-only del CLI su ENTRAMBI i run (in plan mode è la sola apertura Bash).
      expect(briefCall?.allowedTools).toEqual(GRAPHIFY_AGENT_ALLOWED_TOOLS);
      expect(orientCall?.allowedTools).toEqual(GRAPHIFY_AGENT_ALLOWED_TOOLS);
      // Il resto del run è invariato.
      expect(orientCall?.permissionMode).toBe("plan");
    });

    it("graphsDir cablata ma repo SENZA grafo: prompt e run identici a prima (fail-open)", async () => {
      const { db } = testDb;
      const upstream = await makeUpstream();
      const mirrors = await makeMirrors();
      const repositoryId = await createRepository(db, upstream.url);
      const graphsDir = await makeGraphsDir(); // nessun graph.json per questo repository
      const job = await enqueueTrigger(db, repositoryId);

      const runner = new FakeAgentRunner({
        script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
      });
      const outcome = await runOrientation(
        { ...baseDeps(db, mirrors, runner), graphsDir },
        job,
      );
      expect(outcome).toBe("seeded");
      for (const call of runner.calls) {
        expect(call.prompt).not.toContain("CODE GRAPH");
        expect(call.prompt).not.toContain("graphify");
        expect(call.allowedTools).toBeUndefined();
      }
    });

    it("grafo corrotto: nessuna mappa, ma i comandi e l'allowlist restano (fail-open)", async () => {
      const { db } = testDb;
      const upstream = await makeUpstream();
      const mirrors = await makeMirrors();
      const repositoryId = await createRepository(db, upstream.url);
      const graphsDir = await makeGraphsDir();
      const outDir = join(graphsDir, repositoryId, "graphify-out");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "graph.json"), "{ questo non è JSON");
      const job = await enqueueTrigger(db, repositoryId);

      const runner = new FakeAgentRunner({
        script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
      });
      const outcome = await runOrientation(
        { ...baseDeps(db, mirrors, runner), graphsDir },
        job,
      );
      // La generazione non si accorge di nulla: seminata come sempre.
      expect(outcome).toBe("seeded");
      const orientCall = runner.calls[1];
      expect(orientCall?.prompt).not.toContain("CODE GRAPH MAP");
      expect(orientCall?.prompt).toContain("graphify query");
      expect(orientCall?.allowedTools).toEqual(GRAPHIFY_AGENT_ALLOWED_TOOLS);
    });

    it("senza graphsDir: comportamento invariato (nessun accesso al volume)", async () => {
      const { db } = testDb;
      const upstream = await makeUpstream();
      const mirrors = await makeMirrors();
      const repositoryId = await createRepository(db, upstream.url);
      const job = await enqueueTrigger(db, repositoryId);

      const runner = new FakeAgentRunner({
        script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
      });
      expect(await runOrientation(baseDeps(db, mirrors, runner), job)).toBe("seeded");
      for (const call of runner.calls) {
        expect(call.prompt).not.toContain("CODE GRAPH");
        expect(call.allowedTools).toBeUndefined();
      }
    });
  });

  it("con pinnedProviderId: la riga doc_generations seminata ha pinned_provider_id valorizzato", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    // Un provider AI abilitato da bloccare sulla generazione.
    const [provider] = await db
      .insert(aiProviders)
      .values({
        label: "Pinned",
        kind: "api_key",
        secretEncrypted: encrypt("sk-pinned", ENCRYPTION_KEY),
        enabled: true,
        position: 0,
      })
      .returning();

    const runner = new FakeAgentRunner({
      script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
    });
    const outcome = await runOrientation(
      { ...baseDeps(db, mirrors, runner), pinnedProviderId: provider!.id },
      job,
    );
    expect(outcome).toBe("seeded");

    // Il pin è seminato su doc_generations: i job-nodo lo rileggeranno.
    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.pinnedProviderId).toBe(provider!.id);
  });

  it("senza pin: doc_generations.pinned_provider_id resta null (regressione)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    const runner = new FakeAgentRunner({
      script: scriptBriefThenOrient(VALID_BRIEF, VALID_PLAN),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("seeded");

    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.pinnedProviderId).toBeNull();
  });

  it("brief non parsabile (prosa) → brief null, l'orientamento procede normalmente (regressione)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    // Il run del brief risponde con prosa non parsabile; l'orientamento risponde bene.
    const runner = new FakeAgentRunner({
      script: scriptBriefThenOrient(
        "Non ho capito la domanda, ecco delle riflessioni libere sul repo.",
        VALID_PLAN,
      ),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    // Il brief fallito NON rompe la generazione: si semina comunque.
    expect(outcome).toBe("seeded");
    expect(runner.calls).toHaveLength(2);

    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    // Brief null (non parsabile), ma la generazione è viva e ha seminato il DAG.
    expect(gen?.status).toBe("running");
    expect(gen?.brief).toBeNull();
    // Costo comunque sommato (brief 0.02 + orient 0.02).
    expect(Number(gen?.cost)).toBeCloseTo(0.04, 6);

    // Senza brief l'orientamento NON riceve il blocco PROJECT CONTEXT (prompt come prima).
    const orientCall = runner.calls[1];
    expect(orientCall?.prompt).not.toContain("PROJECT CONTEXT");

    // Le due radici + i quattro figli sono seminati come nel percorso nominale.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes.filter((n) => n.parentId === null)).toHaveLength(2);
    expect(nodes.filter((n) => n.parentId !== null)).toHaveLength(4);
  });

  it("output invalido (niente marcatori) → retry → fallback: generazione failed, trigger failed", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    const runner = new FakeAgentRunner({
      script: () => ({
        output: "Ecco il mio piano in prosa libera, senza marcatori del contratto.",
        exitCode: 0,
        usage: USAGE,
      }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("failed");

    // TRE run: 1 brief (prosa non parsabile → nessun brief, si prosegue) + 2 tentativi
    // di orientamento (retry prima del fallback). Il brief non rompe la generazione: è
    // l'orientamento invalido a farla fallire.
    expect(runner.calls).toHaveLength(3);

    // Generazione failed, brief null (non parsabile), nessun nodo seminato.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.status).toBe("failed");
    expect(gen?.brief).toBeNull();
    expect(gen?.error).toMatch(/orientamento|marcatori|non valido/i);
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes).toHaveLength(0);

    // Trigger failed (niente DAG da far avanzare).
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");
  });

  it("orientamento su run al limite: trigger held con held_reason 'limit', generazione failed con messaggio esplicito", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    // Run al limite di rate/usage del provider (exit non-zero + marcatore).
    const runner = new FakeAgentRunner({
      script: () => ({ output: "API Error: usage limit reached", exitCode: 1, usage: USAGE }),
    });
    const registry = createGenerationWorktreeRegistry();
    const outcome = await runOrientation({ ...baseDeps(db, mirrors, runner), registry }, job);
    expect(outcome).toBe("held");

    // DUE run: il brief tocca il limite (nessun brief, si prosegue senza retry) e poi
    // anche l'orientamento lo tocca (che NON consuma il retry: sarebbe un run bruciato).
    expect(runner.calls).toHaveLength(2);

    // La generazione FALLISCE con un messaggio esplicito (il DAG non esiste ancora:
    // niente pausa — alla ripresa il job riaccodato ne crea una FRESCA).
    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toMatch(/limite di rate\/usage/i);
    expect(gen?.finishedAt).not.toBeNull();
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes).toHaveLength(0);

    // Il trigger è HELD (non failed) con held_reason 'limit': il resume poller
    // lo riaccoderà al reset del limite.
    const [jobAfter] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    expect(jobAfter?.error).toMatch(/limite/i);
    expect(jobAfter?.finishedAt).not.toBeNull();

    // Worktree CHIUSO e NON registrato (nessun leak).
    expect(registry.has(gen!.id)).toBe(false);
    expect(registry.activeRepositoryIds().size).toBe(0);
  });

  it("radice senza figli (child-list vuota) → done con pendingChildren=0 (caso degenere)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    // Piano valido (marcatori presenti) ma con la sola child-list tecnica popolata.
    const planFuncEmpty = [
      ORIENT_START_MARKER,
      "Solo unità tecniche, nessuna capability funzionale rilevata.",
      ORIENT_TECHNICAL_START_MARKER,
      "- Core Module :: src/core :: il cuore",
      ORIENT_TECHNICAL_END_MARKER,
      ORIENT_FUNCTIONAL_START_MARKER,
      ORIENT_FUNCTIONAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");

    const runner = new FakeAgentRunner({
      script: () => ({ output: planFuncEmpty, exitCode: 0, usage: USAGE }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("seeded");

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    const funcRoot = nodes.find((n) => n.parentId === null && n.tree === "functional");
    // Radice funzionale degenere: done, pendingChildren 0, nessun figlio.
    expect(funcRoot?.status).toBe("done");
    expect(funcRoot?.pendingChildren).toBe(0);
    expect(funcRoot?.finishedAt).not.toBeNull();
    expect(nodes.filter((n) => n.parentId === funcRoot!.id)).toHaveLength(0);
    // La radice tecnica invece ha il suo unico figlio e attende.
    const techRoot = nodes.find((n) => n.parentId === null && n.tree === "technical");
    expect(techRoot?.status).toBe("awaiting_children");
    expect(techRoot?.pendingChildren).toBe(1);
  });

  it("piano VUOTO (entrambe le child-list vuote) → orientamento fallito: generazione failed, trigger failed, nessun nodo (C1)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const job = await enqueueTrigger(db, repositoryId);

    // Piano coi marcatori presenti (parse valido) ma ENTRAMBE le child-list vuote:
    // l'agente non ha trovato nulla da documentare. Senza il fix la generazione
    // resterebbe `running` per sempre (nessun nodo → finalizzazione mai innescata).
    const emptyPlan = [
      ORIENT_START_MARKER,
      "Nessuna unità tecnica né capability funzionale rilevata.",
      ORIENT_TECHNICAL_START_MARKER,
      ORIENT_TECHNICAL_END_MARKER,
      ORIENT_FUNCTIONAL_START_MARKER,
      ORIENT_FUNCTIONAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");

    const runner = new FakeAgentRunner({
      script: () => ({ output: emptyPlan, exitCode: 0, usage: USAGE }),
    });
    const registry = createGenerationWorktreeRegistry();
    const outcome = await runOrientation(
      { ...baseDeps(db, mirrors, runner), registry },
      job,
    );
    expect(outcome).toBe("failed");

    // Generazione failed (NON stuck running) con ragione "piano vuoto"; nessun nodo seminato.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toMatch(/vuoto|nessuna unità/i);
    expect(gen?.finishedAt).not.toBeNull();
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes).toHaveLength(0);

    // Trigger failed.
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");

    // Worktree CHIUSO: il registro non ha l'handle (nessun leak), nessun progetto attivo.
    expect(registry.has(gen!.id)).toBe(false);
    expect(registry.activeRepositoryIds().size).toBe(0);
  });

  it("guard DB: un secondo trigger con una generazione già `running` per il progetto NON ne avvia una seconda (C2)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    // Simula una generazione GIÀ in corso per il progetto (es. avviata da un trigger
    // precedente o sopravvissuta a un riavvio): una riga doc_generations `running`.
    await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", model: "opus" });

    const job = await enqueueTrigger(db, repositoryId);
    const runner = new FakeAgentRunner({
      script: () => ({ output: VALID_PLAN, exitCode: 0, usage: USAGE }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("skipped");

    // L'agente NON è stato invocato (nessun orientamento avviato).
    expect(runner.calls).toHaveLength(0);

    // NESSUNA seconda generazione creata: resta solo la riga running preesistente.
    const gens = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("running");

    // Nessun nodo seminato.
    const nodes = await db
      .select()
      .from(docNodes)
      .where(eq(docNodes.repositoryId, repositoryId));
    expect(nodes).toHaveLength(0);

    // Il trigger è chiuso `succeeded`-skip (nessun errore: una generazione è già in corso).
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("succeeded");
  });
});
