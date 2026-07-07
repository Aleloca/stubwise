import {
  aiProviders,
  docAutoUpdateJobs,
  docChunks,
  docGenerations,
  docPages,
  encrypt,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  GROW_PROPOSAL_END_MARKER,
  GROW_PROPOSAL_START_MARKER,
  REFRESH_NO_CHANGE_MARKER,
  REFRESH_UPDATED_END_MARKER,
  REFRESH_UPDATED_START_MARKER,
  RELEASE_BODY_END_MARKER,
  RELEASE_BODY_START_MARKER,
  RELEASE_END_MARKER,
  RELEASE_SLUGS_END_MARKER,
  RELEASE_SLUGS_START_MARKER,
  RELEASE_START_MARKER,
  SECRETS_DETAIL_MARKER,
  SECRETS_VERDICT_MARKER,
  SOURCE_PATHS_END_MARKER,
  SOURCE_PATHS_START_MARKER,
  type ProjectBrief,
} from "@stubwise/docs-engine";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { and, eq, isNull, or } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import type { AgentRunResult } from "../agent/runner.js";
import { createProjectSerializer } from "../handler.js";
import { MirrorManager } from "../git/mirrors.js";
import { isNoise, runAutoUpdate, type RunAutoUpdateDeps } from "./auto-update.js";
import { pollAutoUpdateOnce } from "./auto-update-poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let uniq = 0;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(docAutoUpdateJobs);
  await testDb.db.delete(docChunks);
  await testDb.db.delete(docPages);
  await testDb.db.delete(docGenerations);
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(aiProviders);
  while (cleanups.length > 0) await cleanups.pop()?.();
});

afterAll(async () => {
  await testDb.stop();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

/**
 * Crea un upstream bare con DUE commit e ritorna l'url + i due sha. Tra i due commit
 * cambia `src/app.ts` (sostanziale) e, se `noiseOnly`, SOLO `pnpm-lock.yaml` (rumore).
 */
async function makeUpstream(
  opts: { noiseOnly?: boolean; extraFiles?: Record<string, string> } = {},
): Promise<{
  url: string;
  fromSha: string;
  toSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-autoupdate-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", bare]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", pathToFileURL(bare).href], work);
  const author = ["-c", "user.name=Seed", "-c", "user.email=seed@example.com"];

  await writeFile(join(work, "package.json"), JSON.stringify({ name: "demo" }) + "\n");
  await writeFile(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await execa("git", ["-C", work, "add", "."]);
  await execa("git", ["-C", work, ...author, "commit", "-m", "seed"]);
  const fromSha = (await git(["rev-parse", "HEAD"], work)).trim();

  if (opts.noiseOnly) {
    await writeFile(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# bumped\n");
  } else {
    await mkdir(join(work, "src"), { recursive: true });
    await writeFile(join(work, "src", "app.ts"), "export const v = 2;\n");
    for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
      await mkdir(join(work, dirname(rel)), { recursive: true });
      await writeFile(join(work, rel), content);
    }
  }
  await execa("git", ["-C", work, "add", "-A"]);
  await execa("git", [
    "-C",
    work,
    ...author,
    "commit",
    "-m",
    opts.noiseOnly ? "chore: bump lockfile" : "feat: nuova capability app",
  ]);
  const toSha = (await git(["rev-parse", "HEAD"], work)).trim();

  await git(["push", "origin", "main"], work);
  return { url: pathToFileURL(bare).href, fromSha, toSha };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-autoupdate-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

// Crea un progetto (gruppo) — con docAutoUpdate e l'eventuale aiProviderId, che ora
// vivono sul gruppo — e un repository che vi appartiene. Ritorna il repositoryId
// (l'auto-update è per repository; il provider AI è risolto dal progetto del repository).
async function createRepository(
  db: Db,
  repoUrl: string,
  opts: { providerId?: string | null } = {},
): Promise<string> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    provider: "github",
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  const [project] = await db
    .insert(projects)
    .values({
      name: `Gruppo ${uniq}`,
      slug: `gruppo-${uniq}`,
      ingestionKey: `ingestion-au-${uniq}`,
      docAutoUpdate: true,
      ...(opts.providerId !== undefined ? { aiProviderId: opts.providerId } : {}),
    })
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

/** Crea una generazione corrente + una pagina, e la collega come currentDocGenerationId. */
async function seedCurrentGeneration(
  db: Db,
  repositoryId: string,
  commitSha: string,
): Promise<{ generationId: string; pageSlug: string }> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "succeeded", model: "opus", commitSha })
    .returning();
  const generationId = gen!.id;
  await db.insert(docPages).values({
    repositoryId,
    generationId,
    kind: "technical",
    slug: "app-module",
    title: "App Module",
    sourcePath: "src",
    body: "La pagina del modulo app.",
  });
  await db
    .update(repositories)
    .set({ currentDocGenerationId: generationId })
    .where(eq(repositories.id, repositoryId));
  return { generationId, pageSlug: "app-module" };
}

interface SeedPage {
  slug: string;
  title: string;
  sourcePath: string | null;
  body: string;
}

/**
 * Crea una generazione corrente con un insieme ARBITRARIO di pagine (Fase 2) e la collega
 * come currentDocGenerationId. Ritorna la generationId e gli id delle pagine per slug.
 */
async function seedGenerationWithPages(
  db: Db,
  repositoryId: string,
  commitSha: string,
  pages: SeedPage[],
): Promise<{ generationId: string; pageIds: Record<string, string> }> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "succeeded", model: "opus", commitSha })
    .returning();
  const generationId = gen!.id;
  const pageIds: Record<string, string> = {};
  for (const p of pages) {
    const [row] = await db
      .insert(docPages)
      .values({
        repositoryId,
        generationId,
        kind: "technical",
        slug: p.slug,
        title: p.title,
        sourcePath: p.sourcePath,
        body: p.body,
      })
      .returning({ id: docPages.id });
    pageIds[p.slug] = row!.id;
  }
  await db
    .update(repositories)
    .set({ currentDocGenerationId: generationId })
    .where(eq(repositories.id, repositoryId));
  return { generationId, pageIds };
}

const SIGNIFICANT_OUTPUT = [
  RELEASE_START_MARKER,
  "SIGNIFICANT: true",
  "TITLE: Nuova capability app",
  RELEASE_SLUGS_START_MARKER,
  "- app-module",
  "- inesistente-slug",
  RELEASE_SLUGS_END_MARKER,
  RELEASE_BODY_START_MARKER,
  "## Aggiunto\n- nuova capability nell'app",
  RELEASE_BODY_END_MARKER,
  RELEASE_END_MARKER,
].join("\n");

const MINOR_OUTPUT = [
  RELEASE_START_MARKER,
  "SIGNIFICANT: false",
  "TITLE: Refactor interno",
  RELEASE_SLUGS_START_MARKER,
  RELEASE_SLUGS_END_MARKER,
  RELEASE_BODY_START_MARKER,
  "Refactor senza impatto utente.",
  RELEASE_BODY_END_MARKER,
  RELEASE_END_MARKER,
].join("\n");

/** Output dell'agente di refresh che riscrive il corpo della pagina. */
const REFRESHED_BODY = "Corpo AGGIORNATO della pagina dopo il diff.";
const REFRESH_UPDATED_OUTPUT = [
  REFRESH_UPDATED_START_MARKER,
  REFRESHED_BODY,
  REFRESH_UPDATED_END_MARKER,
].join("\n");
const REFRESH_NO_CHANGE_OUTPUT = REFRESH_NO_CHANGE_MARKER;

/** true se il prompt è quello dell'agente di refresh-pagina (non la entry release). */
function isRefreshPrompt(prompt: string): boolean {
  return prompt.includes(REFRESH_UPDATED_START_MARKER);
}

// ── Helper guard product del refresh (nota review C2 / Task D2) ────────────────

/** Un fatto riservato per il brief dei test del guard product. */
const SECRET_FACT = {
  fact: "18% markup on every top-up",
  reason: "pricing strategy",
  source: "src/pricing.ts",
  avoid: "never state a percentage margin",
} as const;

/** Brief minimo con un fatto riservato (persistito su doc_generations.brief). */
function briefWithSecret(): ProjectBrief {
  return {
    identity: "A demo product.",
    actors: [{ name: "Customer", description: "buys", internal: false }],
    surfaces: [
      { name: "Web", type: "web app", rootPath: "src", audience: "customers", internal: false },
    ],
    glossary: [],
    invariants: [],
    confidentialFacts: [SECRET_FACT],
    journeys: [],
    existingSources: [],
  };
}

/** true se il prompt è quello del verificatore segreti (red-teamer, Fase C). */
function isAuditPrompt(prompt: string): boolean {
  return prompt.includes("You are a RED-TEAMER");
}

/** Output di audit `CLEAN` (nessuna violazione). */
const AUDIT_CLEAN = [SECRETS_VERDICT_MARKER, "CLEAN", SECRETS_DETAIL_MARKER, ""].join("\n");

/** Output di audit `VIOLATION` col detail. */
const AUDIT_VIOLATION = [
  SECRETS_VERDICT_MARKER,
  "VIOLATION",
  SECRETS_DETAIL_MARKER,
  "Fact: 18% markup. Passage: 'a 18% margin is added'.",
].join("\n");

/**
 * Body di una GUIDA product VALIDO: cinque sezioni `###` obbligatorie + un passo numerato in
 * `### Steps` con un ancoraggio `NAV:` (soddisfa `parseProductGuideOutput`). L'agente di
 * refresh lo restituisce tra i marcatori REFRESH_UPDATED, il guard lo ri-valida.
 */
const VALID_GUIDE_BODY = [
  "### Goal",
  "Learn to buy a top-up.",
  "### Prerequisites",
  "An account.",
  "### Steps",
  "1. Open the app. NAV: Menu → Top-up [/topup]",
  "### Expected result",
  "Credit is added.",
  "### Common issues",
  "None.",
].join("\n");

/** Body di guida SENZA ancoraggi di navigazione: `parseProductGuideOutput` → reason. */
const GUIDE_BODY_NO_NAV = [
  "### Goal",
  "Learn to buy a top-up.",
  "### Prerequisites",
  "An account.",
  "### Steps",
  "1. Open the app.",
  "### Expected result",
  "Credit is added.",
  "### Common issues",
  "None.",
].join("\n");

/** Costruisce l'output dell'agente di refresh (marcatori UPDATED) attorno a un body. */
function refreshUpdated(body: string): string {
  return [REFRESH_UPDATED_START_MARKER, body, REFRESH_UPDATED_END_MARKER].join("\n");
}

/**
 * Semina una generazione corrente con UNA pagina (kind arbitrario, sourcePath arbitrario) e,
 * opzionalmente, un brief. Ritorna generationId + pageId. Serve al guard del refresh product:
 * la pagina product è seminata con sourcePath NON null per SIMULARE il caso futuro in cui il
 * mapping diff→pagine la selezionerebbe (oggi le product hanno sourcePath null e non entrano
 * mai nel refresh — vedi la nota della guardia).
 */
async function seedGenerationWithOnePage(
  db: Db,
  repositoryId: string,
  commitSha: string,
  page: {
    kind: "product" | "functional" | "technical";
    slug: string;
    title: string;
    sourcePath: string | null;
    body: string;
  },
  brief: ProjectBrief | null,
): Promise<{ generationId: string; pageId: string }> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "succeeded", model: "opus", commitSha, brief })
    .returning();
  const generationId = gen!.id;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: page.kind,
      slug: page.slug,
      title: page.title,
      sourcePath: page.sourcePath,
      body: page.body,
    })
    .returning({ id: docPages.id });
  await db
    .update(repositories)
    .set({ currentDocGenerationId: generationId })
    .where(eq(repositories.id, repositoryId));
  return { generationId, pageId: row!.id };
}

// ── Helper Fase 3 (mini-orient + explore) ─────────────────────────────────────

/** Costruisce un blocco proposta del mini-orient. */
function growProposal(opts: {
  title: string;
  kind: "technical" | "functional";
  parent?: string;
  paths?: string;
}): string {
  return [
    GROW_PROPOSAL_START_MARKER,
    `title: ${opts.title}`,
    `kind: ${opts.kind}`,
    `parent: ${opts.parent ?? ""}`,
    `paths: ${opts.paths ?? ""}`,
    GROW_PROPOSAL_END_MARKER,
  ].join("\n");
}

/** Un corpo explore valido (≥ MIN_BODY_CHARS, non-meta) + blocco children (foglia) + paths. */
function exploreOutput(opts: { body?: string; paths?: string[] } = {}): string {
  const body =
    opts.body ??
    "### Cosa fa\nQuesta area gestisce la fatturazione: creazione fatture, righe, totali e stato di pagamento. Documenta in dettaglio ogni operazione disponibile per l'utente.";
  const pathsLines = (opts.paths ?? []).map((p) => `- ${p}`);
  return [
    EXPLORE_BODY_START_MARKER,
    body,
    EXPLORE_BODY_END_MARKER,
    EXPLORE_CHILDREN_START_MARKER,
    EXPLORE_CHILDREN_END_MARKER,
    SOURCE_PATHS_START_MARKER,
    ...pathsLines,
    SOURCE_PATHS_END_MARKER,
  ].join("\n");
}

/** true se il prompt è quello del mini-orient Fase 3. */
function isGrowOrientPrompt(prompt: string): boolean {
  return prompt.includes(GROW_PROPOSAL_START_MARKER);
}

/** true se il prompt è quello di explore Fase 3. */
function isExplorePrompt(prompt: string): boolean {
  return prompt.includes(EXPLORE_BODY_START_MARKER);
}

/**
 * Script che instrada per tipo di prompt: l'agente di refresh ritorna `refresh`, l'agente
 * release ritorna `release`. Così un singolo runner serve sia la rigenerazione mirata sia
 * la entry, e i test possono asserire su entrambe le fasi.
 */
function routeScript(refresh: string, release: string) {
  return (opts: { prompt: string }) => ({
    output: isRefreshPrompt(opts.prompt) ? refresh : release,
    exitCode: 0,
  });
}

function baseDeps(
  db: Db,
  mirrors: MirrorManager,
  runner: FakeAgentRunner,
  opts: { maxRefreshPages?: number; maxNewPages?: number } = {},
): RunAutoUpdateDeps {
  return {
    db,
    mirrors,
    runner,
    encryptionKey: ENCRYPTION_KEY,
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
    embeddingClient: createFakeEmbeddingClient(),
    // Default 0 = rigenerazione mirata disattivata (comportamento Fase 1): i test Fase 1
    // restano invariati. I test Fase 2 passano esplicitamente un maxRefreshPages > 0.
    maxRefreshPages: opts.maxRefreshPages ?? 0,
    // Default 0 = creazione incrementale (Fase 3) disattivata. I test Fase 3 passano
    // esplicitamente un maxNewPages > 0.
    maxNewPages: opts.maxNewPages ?? 0,
    // Catena vuota di default: provider undefined (auth storica). I test che vogliono
    // un provider bloccato passano aiProviderId + un loadProviderByIdFn fake.
    loadProviderChainFn: async () => [],
  };
}

describe("isNoise", () => {
  it("riconosce lockfile e cartelle di processo, non i file di prodotto", () => {
    expect(isNoise("pnpm-lock.yaml")).toBe(true);
    expect(isNoise("apps/web/package-lock.json")).toBe(true);
    expect(isNoise("plans/2026-x.md")).toBe(true);
    expect(isNoise("docs/foo.md")).toBe(true);
    expect(isNoise(".github/workflows/ci.yml")).toBe(true);
    expect(isNoise("src/app.ts")).toBe(false);
    expect(isNoise("apps/server/src/routes/x.ts")).toBe(false);
  });
});

describe("runAutoUpdate", () => {
  it("diff di solo rumore → nessuna entry release, agente NON invocato", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({ noiseOnly: true });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    await runAutoUpdate(baseDeps(db, mirrors, runner), {
      id: "job-1",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    expect(runner.calls).toHaveLength(0);
    const pages = await db.select().from(docPages).where(eq(docPages.repositoryId, repositoryId));
    expect(pages).toHaveLength(0);
  });

  it("diff sostanziale → crea UNA pagina releases persistente, aggiorna commitSha", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedCurrentGeneration(db, repositoryId, upstream.fromSha);

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    await runAutoUpdate(baseDeps(db, mirrors, runner), {
      id: "job-2",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Agente invocato read-only.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    expect(runner.calls[0]?.model).toBe("opus");
    // Il prompt ha ricevuto il file sostanziale e la pagina esistente.
    expect(runner.calls[0]?.prompt).toContain("src/app.ts");
    expect(runner.calls[0]?.prompt).toContain("app-module");

    // UNA pagina releases persistente (generationId null).
    const releases = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(releases).toHaveLength(1);
    const page = releases[0]!;
    expect(page.generationId).toBeNull();
    expect(page.isManual).toBe(false);
    expect(page.title).toBe("Nuova capability app");
    expect(page.body).toContain("nuova capability");
    expect(page.slug).toMatch(/^release-\d{8}-\d{4}-[0-9a-f]+$/);
    expect(page.position).toBeLessThan(0);
    // Cross-link: solo lo slug ESISTENTE, scartato quello inventato.
    expect(page.links).toEqual([{ type: "related", slug: "app-module", title: "App Module" }]);

    // commitSha della generazione corrente avanzato a toSha.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.id, generationId));
    expect(gen?.commitSha).toBe(upstream.toSha);
  });

  it("agente significant=false → titolo con prefisso [minore]", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    const runner = new FakeAgentRunner({ script: () => ({ output: MINOR_OUTPUT, exitCode: 0 }) });
    await runAutoUpdate(baseDeps(db, mirrors, runner), {
      id: "job-3",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    const [page] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(page?.title).toBe("[minore] Refactor interno");
    expect(page?.links).toBeNull();
  });

  it("provider auto impostato ma non risolvibile → nessuna entry, nessun crash", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    // Un provider reale (FK valida) impostato sul progetto, ma reso "non risolvibile" al
    // run (es. disabilitato/cancellato) iniettando un loadProviderById che ritorna null.
    const [provider] = await db
      .insert(aiProviders)
      .values({
        label: "Auto",
        kind: "api_key",
        secretEncrypted: encrypt("sk-auto", ENCRYPTION_KEY),
        enabled: true,
        position: 0,
      })
      .returning();
    const repositoryId = await createRepository(db, upstream.url, { providerId: provider!.id });

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    await runAutoUpdate(
      { ...baseDeps(db, mirrors, runner), loadProviderByIdFn: async () => null },
      { id: "job-4", repositoryId, fromSha: upstream.fromSha, toSha: upstream.toSha },
    );

    // Agente NON invocato, nessuna entry.
    expect(runner.calls).toHaveLength(0);
    const pages = await db.select().from(docPages).where(eq(docPages.repositoryId, repositoryId));
    expect(pages).toHaveLength(0);
  });

  it("sha non raggiungibile → log e termina (best-effort), nessuna entry", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    await runAutoUpdate(baseDeps(db, mirrors, runner), {
      id: "job-5",
      repositoryId,
      fromSha: "0".repeat(40),
      toSha: upstream.toSha,
    });

    expect(runner.calls).toHaveLength(0);
    const pages = await db.select().from(docPages).where(eq(docPages.repositoryId, repositoryId));
    expect(pages).toHaveLength(0);
  });
});

describe("runAutoUpdate — rigenerazione mirata (Fase 2)", () => {
  it("diff su una pagina esistente + agente UPDATED → body aggiornato e chunk ri-embeddati", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream(); // cambia src/app.ts
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId, pageIds } = await seedGenerationWithPages(
      db,
      repositoryId,
      upstream.fromSha,
      [{ slug: "app-module", title: "App Module", sourcePath: "src", body: "Vecchio corpo." }],
    );
    const pageId = pageIds["app-module"]!;

    // Pre-seed di un chunk vecchio per la pagina, così possiamo verificare il DELETE.
    await db.insert(docChunks).values({
      pageId,
      repositoryId,
      generationId,
      content: "vecchio chunk",
      embedding: new Array(1024).fill(0),
      metadata: { heading: null, sourcePath: "src", layer: "technical" },
      tokenCount: 2,
    });

    const runner = new FakeAgentRunner({
      script: routeScript(REFRESH_UPDATED_OUTPUT, SIGNIFICANT_OUTPUT),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-r1",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Sia il refresh sia la entry sono stati invocati (un run di refresh + uno di release).
    expect(runner.calls.some((c) => c.prompt.includes(REFRESH_UPDATED_START_MARKER))).toBe(true);
    // Il refresh gira nel worktree (cwd != process.cwd()).
    const refreshCall = runner.calls.find((c) => c.prompt.includes(REFRESH_UPDATED_START_MARKER));
    expect(refreshCall?.permissionMode).toBe("plan");
    expect(refreshCall?.cwd).not.toBe(process.cwd());

    // La pagina ha il body aggiornato.
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe(REFRESHED_BODY);

    // I chunk sono stati RI-EMBEDDATI: il vecchio chunk (content "vecchio chunk") è sparito
    // e ce n'è almeno uno nuovo dal nuovo body.
    const chunks = await db.select().from(docChunks).where(eq(docChunks.pageId, pageId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.content !== "vecchio chunk")).toBe(true);
    // Invariante "nessuna fuga di generationId": TUTTI i nuovi chunk appartengono alla
    // generazione corrente (non a una vecchia/altra).
    expect(chunks.every((c) => c.generationId === generationId)).toBe(true);

    // La entry release esiste e i link related includono lo slug aggiornato.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release).toBeDefined();
    expect(release?.links).toEqual([
      { type: "related", slug: "app-module", title: "App Module" },
    ]);
  });

  it("agente NO CHANGE → pagina non toccata, nessun re-embed", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId, pageIds } = await seedGenerationWithPages(
      db,
      repositoryId,
      upstream.fromSha,
      [{ slug: "app-module", title: "App Module", sourcePath: "src", body: "Corpo originale." }],
    );
    const pageId = pageIds["app-module"]!;
    await db.insert(docChunks).values({
      pageId,
      repositoryId,
      generationId,
      content: "chunk originale",
      embedding: new Array(1024).fill(0),
      metadata: { heading: null, sourcePath: "src", layer: "technical" },
      tokenCount: 2,
    });

    const runner = new FakeAgentRunner({
      script: routeScript(REFRESH_NO_CHANGE_OUTPUT, SIGNIFICANT_OUTPUT),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-r2",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Body invariato, chunk originale ancora presente (nessun delete+reinsert).
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe("Corpo originale.");
    const chunks = await db.select().from(docChunks).where(eq(docChunks.pageId, pageId));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("chunk originale");
    // I cross-link NON includono la pagina (non aggiornata, e non negli affectedSlugs lato
    // release per questo scenario? sì lo è: app-module è in SIGNIFICANT_OUTPUT). Quindi il
    // link c'è comunque dall'agente release, ma NON per il refresh.
  });

  it("pagine non impattate dal diff → invariate (nessun refresh)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream(); // cambia solo src/app.ts
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageIds } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Vecchio app." },
      { slug: "other-module", title: "Other", sourcePath: "lib", body: "Corpo other." },
    ]);

    const runner = new FakeAgentRunner({
      script: routeScript(REFRESH_UPDATED_OUTPUT, SIGNIFICANT_OUTPUT),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-r3",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // app-module (sourcePath src) aggiornata, other-module (sourcePath lib) intatta.
    const [app] = await db.select().from(docPages).where(eq(docPages.id, pageIds["app-module"]!));
    const [other] = await db.select().from(docPages).where(eq(docPages.id, pageIds["other-module"]!));
    expect(app?.body).toBe(REFRESHED_BODY);
    expect(other?.body).toBe("Corpo other.");
  });

  it("file non mappato → in newAreas e segnalato nella entry release", async () => {
    const { db } = testDb;
    // Cambia src/app.ts (coperto da src) E un file non coperto da alcuna pagina.
    const upstream = await makeUpstream({ extraFiles: { "uncovered/thing.ts": "export const u = 1;\n" } });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Vecchio app." },
    ]);

    const runner = new FakeAgentRunner({
      script: routeScript(REFRESH_UPDATED_OUTPUT, SIGNIFICANT_OUTPUT),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-r4",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release?.body).toContain("Aree nuove non documentate");
    expect(release?.body).toContain("uncovered/thing.ts");
  });

  it("maxRefreshPages=0 → nessuna rigenerazione, solo la entry (Fase 1 invariata)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageIds } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Corpo intatto." },
    ]);

    const runner = new FakeAgentRunner({
      script: routeScript(REFRESH_UPDATED_OUTPUT, SIGNIFICANT_OUTPUT),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 0 }), {
      id: "job-r5",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Nessun run di refresh (solo l'agente release).
    expect(runner.calls.some((c) => c.prompt.includes(REFRESH_UPDATED_START_MARKER))).toBe(false);
    expect(runner.calls).toHaveLength(1);
    // Pagina intatta.
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageIds["app-module"]!));
    expect(page?.body).toBe("Corpo intatto.");
    // Entry comunque creata.
    const releases = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(releases).toHaveLength(1);
  });

  it("un refresh che fallisce su una pagina → le altre procedono e la entry è creata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({ extraFiles: { "lib/util.ts": "export const x = 9;\n" } });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageIds } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Vecchio app." },
      { slug: "lib-module", title: "Lib Module", sourcePath: "lib", body: "Vecchio lib." },
    ]);

    // Il refresh della pagina con sourcePath "lib" lancia; quello della pagina "src" ok.
    const runner = new FakeAgentRunner({
      script: (opts) => {
        if (opts.prompt.includes(REFRESH_UPDATED_START_MARKER)) {
          // È un prompt di refresh: distinguo per il sourcePath citato nel prompt.
          if (opts.prompt.includes("Source path documented by this page: lib")) {
            throw new Error("boom: refresh lib fallito");
          }
          return { output: REFRESH_UPDATED_OUTPUT, exitCode: 0 };
        }
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-r6",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // app-module aggiornata nonostante il fallimento di lib-module.
    const [app] = await db.select().from(docPages).where(eq(docPages.id, pageIds["app-module"]!));
    const [lib] = await db.select().from(docPages).where(eq(docPages.id, pageIds["lib-module"]!));
    expect(app?.body).toBe(REFRESHED_BODY);
    expect(lib?.body).toBe("Vecchio lib."); // non aggiornata (refresh fallito)
    // La entry release è comunque creata.
    const releases = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(releases).toHaveLength(1);
  });
});

describe("runAutoUpdate — guard refresh pagine product (Task D2)", () => {
  it("pagina product con facts, audit CLEAN → body aggiornato", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream(); // cambia src/app.ts
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    // Pagina product seminata con sourcePath "src" (NON null) per simulare il caso futuro.
    const { pageId } = await seedGenerationWithOnePage(
      db,
      repositoryId,
      upstream.fromSha,
      { kind: "product", slug: "web-guide", title: "Web guide", sourcePath: "src", body: "Vecchio corpo product." },
      briefWithSecret(),
    );

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        if (isAuditPrompt(opts.prompt)) return { output: AUDIT_CLEAN, exitCode: 0 };
        if (isRefreshPrompt(opts.prompt)) return { output: refreshUpdated("Nuovo corpo product pulito."), exitCode: 0 };
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-d2-1",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // L'audit è stato eseguito e il body è stato aggiornato.
    expect(runner.calls.some((c) => isAuditPrompt(c.prompt))).toBe(true);
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe("Nuovo corpo product pulito.");
  });

  it("pagina product con facts, audit VIOLATION → body NON aggiornato (resta il vecchio)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageId } = await seedGenerationWithOnePage(
      db,
      repositoryId,
      upstream.fromSha,
      { kind: "product", slug: "web-guide", title: "Web guide", sourcePath: "src", body: "Vecchio corpo verificato." },
      briefWithSecret(),
    );

    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        if (isAuditPrompt(opts.prompt)) return { output: AUDIT_VIOLATION, exitCode: 0 };
        if (isRefreshPrompt(opts.prompt)) return { output: refreshUpdated("Corpo che rivela il 18% di margine."), exitCode: 0 };
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-d2-2",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Audit eseguito, body INVARIATO (la vecchia pagina già verificata resta).
    expect(runner.calls.some((c) => isAuditPrompt(c.prompt))).toBe(true);
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe("Vecchio corpo verificato.");
  });

  it("guida product senza ancoraggi NAV nel body rinfrescato → NON aggiornata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageId } = await seedGenerationWithOnePage(
      db,
      repositoryId,
      upstream.fromSha,
      { kind: "product", slug: "web-guide", title: "Web guide", sourcePath: "src", body: VALID_GUIDE_BODY },
      briefWithSecret(),
    );

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        if (isAuditPrompt(opts.prompt)) {
          auditRuns += 1;
          return { output: AUDIT_CLEAN, exitCode: 0 };
        }
        // Il refresh restituisce una guida SENZA NAV → la ri-validazione NAV fallisce.
        if (isRefreshPrompt(opts.prompt)) return { output: refreshUpdated(GUIDE_BODY_NO_NAV), exitCode: 0 };
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-d2-3",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // La ri-validazione NAV blocca PRIMA dell'audit: body invariato, audit non eseguito.
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe(VALID_GUIDE_BODY);
    expect(auditRuns).toBe(0);
  });

  it("pagina functional → NESSUN audit (il guard non scatta), body aggiornato", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { pageId } = await seedGenerationWithOnePage(
      db,
      repositoryId,
      upstream.fromSha,
      { kind: "functional", slug: "app-fn", title: "App", sourcePath: "src", body: "Vecchio functional." },
      briefWithSecret(),
    );

    let auditRuns = 0;
    const runner = new FakeAgentRunner({
      script: (opts): AgentRunResult => {
        if (isAuditPrompt(opts.prompt)) {
          auditRuns += 1;
          return { output: AUDIT_CLEAN, exitCode: 0 };
        }
        if (isRefreshPrompt(opts.prompt)) return { output: refreshUpdated("Nuovo functional."), exitCode: 0 };
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 10 }), {
      id: "job-d2-4",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Nessun audit per una pagina functional; body aggiornato normalmente.
    expect(auditRuns).toBe(0);
    const [page] = await db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(page?.body).toBe("Nuovo functional.");
  });
});

describe("runAutoUpdate — creazione incrementale (Fase 3)", () => {
  /**
   * Script Fase 3: instrada per tipo di prompt. mini-orient → `orient`, explore →
   * `explore` (può dipendere dal titolo citato nel prompt), release → `release`, refresh
   * → `refresh`.
   */
  function growScript(opts: {
    orient: string;
    explore: string | ((prompt: string) => AgentRunResult);
    release?: string;
    refresh?: string;
  }) {
    return (call: { prompt: string }): AgentRunResult => {
      if (isGrowOrientPrompt(call.prompt)) return { output: opts.orient, exitCode: 0 };
      if (isExplorePrompt(call.prompt)) {
        return typeof opts.explore === "function"
          ? opts.explore(call.prompt)
          : { output: opts.explore, exitCode: 0 };
      }
      if (isRefreshPrompt(call.prompt)) {
        return { output: opts.refresh ?? REFRESH_NO_CHANGE_OUTPUT, exitCode: 0 };
      }
      return { output: opts.release ?? SIGNIFICANT_OUTPUT, exitCode: 0 };
    };
  }

  it("area nuova → pagina creata nella generazione corrente (slug/kind/parentId/position/sourcePath/chunks) e visibile dal retrieval", async () => {
    const { db } = testDb;
    // app.ts coperto da `src`; billing/* è un'area nuova non coperta da alcuna pagina.
    const upstream = await makeUpstream({
      extraFiles: {
        "billing/invoice.ts": "export const inv = 1;\n",
        "billing/payment.ts": "export const pay = 2;\n",
      },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId, pageIds } = await seedGenerationWithPages(
      db,
      repositoryId,
      upstream.fromSha,
      [{ slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." }],
    );

    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({
          title: "Fatturazione",
          kind: "functional",
          parent: "app-module",
          paths: "billing",
        }),
        // L'explore raffina un sourcePath PIÙ STRETTO (un singolo file) della proposta:
        // la pagina deve comunque persistere il path folder-level della proposta (`billing`),
        // altrimenti i fratelli dell'area tornano scoperti in newAreas → duplicati.
        explore: exploreOutput({ paths: ["billing/invoice.ts"] }),
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g1",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // La pagina creata esiste nella generazione corrente.
    const [page] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId), eq(docPages.slug, "fatturazione")));
    expect(page).toBeDefined();
    expect(page?.kind).toBe("functional");
    expect(page?.title).toBe("Fatturazione");
    expect(page?.parentId).toBe(pageIds["app-module"]); // parentId dal parentSlug
    // Path folder-level della proposta, NON quello (più stretto) raffinato dall'explore.
    expect(page?.sourcePath).toBe("billing");
    expect(page?.generationId).toBe(generationId);
    // position in coda (> della pagina esistente app-module, che è 0).
    expect(page?.position).toBeGreaterThan(0);

    // Chunk embeddati per la pagina.
    const chunks = await db.select().from(docChunks).where(eq(docChunks.pageId, page!.id));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.generationId === generationId)).toBe(true);

    // Visibile dal predicato del retrieval (generation_id = corrente OR IS NULL).
    const visible = await db
      .select({ id: docPages.id })
      .from(docPages)
      .where(
        and(
          eq(docPages.repositoryId, repositoryId),
          eq(docPages.slug, "fatturazione"),
          or(eq(docPages.generationId, generationId), isNull(docPages.generationId)),
        ),
      );
    expect(visible).toHaveLength(1);
  });

  it("slug collidente col titolo di una pagina esistente → suffisso -2", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
      // Pagina esistente con slug "fatturazione": la nuova col titolo "Fatturazione" collide.
      { slug: "fatturazione", title: "Vecchia Fatturazione", sourcePath: "old", body: "Vecchia." },
    ]);

    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({ title: "Fatturazione", kind: "technical", paths: "billing" }),
        explore: exploreOutput({ paths: ["billing"] }),
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g2",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    const created = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId), eq(docPages.slug, "fatturazione-2")));
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("Fatturazione");
  });

  it("body vuoto dall'explore → nessuna pagina creata, area nel residuo (segnalata nella entry)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    // Explore restituisce marcatori vuoti → parseExploreOutput scarta (body too-short).
    const emptyExplore = [
      EXPLORE_BODY_START_MARKER,
      "",
      EXPLORE_BODY_END_MARKER,
      EXPLORE_CHILDREN_START_MARKER,
      EXPLORE_CHILDREN_END_MARKER,
      SOURCE_PATHS_START_MARKER,
      SOURCE_PATHS_END_MARKER,
    ].join("\n");
    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({ title: "Fatturazione", kind: "technical", paths: "billing" }),
        explore: emptyExplore,
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g3",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Nessuna pagina technical creata (solo app-module esistente).
    const nonRelease = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId)));
    expect(nonRelease).toHaveLength(1); // solo app-module
    // La entry release segnala l'area residua billing.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release?.body).toContain("Aree nuove non documentate");
    expect(release?.body).toContain("billing");
  });

  it("proposta senza sourcePaths → scartata (niente pagina), area nel residuo", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    // Proposta senza `paths`: nessun fallback su un'area — la proposta è scartata prima
    // dell'explore (che quindi non è mai chiamato).
    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({ title: "Fatturazione", kind: "technical", paths: "" }),
        explore: exploreOutput({ paths: ["billing"] }),
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g3b",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Nessuna pagina creata oltre app-module esistente.
    const nonRelease = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId)));
    expect(nonRelease).toHaveLength(1); // solo app-module
    // L'explore non è mai stato invocato (proposta scartata a monte).
    expect(runner.calls.filter((c) => isExplorePrompt(c.prompt))).toHaveLength(0);
    // L'area billing resta nel residuo, segnalata nella entry release.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release?.body).toContain("Aree nuove non documentate");
    expect(release?.body).toContain("billing");
  });

  it("tetto maxNewPages 1 con 2 proposte → 1 pagina creata, 1 residuo", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: {
        "billing/a.ts": "export const a = 1;\n",
        "reports/r.ts": "export const r = 1;\n",
      },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    const twoProposals = [
      growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }),
      growProposal({ title: "Report", kind: "functional", paths: "reports" }),
    ].join("\n\n");
    const runner = new FakeAgentRunner({
      script: growScript({ orient: twoProposals, explore: exploreOutput() }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 1 }), {
      id: "job-g4",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Una sola pagina creata (oltre app-module).
    const created = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId)));
    expect(created).toHaveLength(2); // app-module + 1 creata
    // Un solo run di explore (tetto rispettato: la 2ª proposta non è esplorata).
    const exploreCalls = runner.calls.filter((c) => isExplorePrompt(c.prompt));
    expect(exploreCalls).toHaveLength(1);
    // L'area oltre il tetto (reports) resta nel residuo → segnalata nella entry release.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release?.body).toContain("Aree nuove non documentate");
    expect(release?.body).toContain("reports");
  });

  it("2 proposte valide nella stessa run → 2 pagine con slug distinti e position incrementali", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: {
        "billing/a.ts": "export const a = 1;\n",
        "reports/r.ts": "export const r = 1;\n",
      },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    const twoProposals = [
      growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }),
      growProposal({ title: "Report", kind: "functional", paths: "reports" }),
    ].join("\n\n");
    const runner = new FakeAgentRunner({
      script: growScript({
        orient: twoProposals,
        // Un explore diverso per proposta (path coerenti col titolo citato nel prompt).
        explore: (prompt) =>
          prompt.includes("Report")
            ? { output: exploreOutput({ paths: ["reports"] }), exitCode: 0 }
            : { output: exploreOutput({ paths: ["billing"] }), exitCode: 0 },
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g4b",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Due pagine create (oltre app-module), con slug distinti.
    const created = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId)));
    const bySlug = new Map(created.map((p) => [p.slug, p]));
    expect(bySlug.has("fatturazione")).toBe(true);
    expect(bySlug.has("report")).toBe(true);
    // Slug distinti (nessuna collisione).
    const slugs = created.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // Position incrementali: entrambe > 0 (app-module è 0) e distinte tra loro.
    const posFatt = bySlug.get("fatturazione")!.position;
    const posRep = bySlug.get("report")!.position;
    expect(posFatt).toBeGreaterThan(0);
    expect(posRep).toBeGreaterThan(0);
    expect(posFatt).not.toBe(posRep);
  });

  it("explore che lancia per una proposta → l'altra è creata comunque, l'area fallita resta nel residuo", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: {
        "billing/a.ts": "export const a = 1;\n",
        "reports/r.ts": "export const r = 1;\n",
      },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId } = await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    const twoProposals = [
      growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }),
      growProposal({ title: "Report", kind: "functional", paths: "reports" }),
    ].join("\n\n");
    const runner = new FakeAgentRunner({
      script: growScript({
        orient: twoProposals,
        // L'explore per "Report" LANCIA; quello per "Fatturazione" riesce.
        explore: (prompt) => {
          if (prompt.includes("Report")) throw new Error("boom: explore reports fallito");
          return { output: exploreOutput({ paths: ["billing"] }), exitCode: 0 };
        },
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g4c",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // La proposta buona è creata; la fallita no.
    const created = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId)));
    const slugs = new Set(created.map((p) => p.slug));
    expect(slugs.has("fatturazione")).toBe(true);
    expect(slugs.has("report")).toBe(false);
    expect(created).toHaveLength(2); // app-module + fatturazione

    // L'area fallita (reports) resta nel residuo → segnalata nella entry release;
    // billing (documentata) NO.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(release?.body).toContain("Aree nuove non documentate");
    expect(release?.body).toContain("reports");
    expect(release?.body).not.toContain("billing");
  });

  it("maxNewPages 0 → Fase 3 spenta (nessun mini-orient/explore)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({ title: "Fatturazione", kind: "technical", paths: "billing" }),
        explore: exploreOutput(),
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 0, maxRefreshPages: 0 }), {
      id: "job-g5",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    expect(runner.calls.some((c) => isGrowOrientPrompt(c.prompt))).toBe(false);
    expect(runner.calls.some((c) => isExplorePrompt(c.prompt))).toBe(false);
    // Solo l'agente release.
    expect(runner.calls).toHaveLength(1);
  });

  it("Fase 3 attiva con maxRefreshPages 0 → newAreas calcolate e pagina creata (gate fixato)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    const { generationId, pageIds } = await seedGenerationWithPages(
      db,
      repositoryId,
      upstream.fromSha,
      [{ slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." }],
    );

    const runner = new FakeAgentRunner({
      script: growScript({
        orient: growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }),
        explore: exploreOutput({ paths: ["billing"] }),
      }),
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxRefreshPages: 0, maxNewPages: 5 }), {
      id: "job-g6",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // La pagina è stata creata (la Fase 3 gira anche con refresh spento).
    const created = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.generationId, generationId), eq(docPages.slug, "fatturazione")));
    expect(created).toHaveLength(1);
    // La pagina esistente NON è stata rigenerata (refresh spento): resta col corpo originale.
    const [app] = await db.select().from(docPages).where(eq(docPages.id, pageIds["app-module"]!));
    expect(app?.body).toBe("Pagina app.");
    // Nessun run di refresh.
    expect(runner.calls.some((c) => isRefreshPrompt(c.prompt))).toBe(false);
  });

  it("stats/cost della generazione aggiornati con l'esito della Fase 3", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    // Genera con stats iniziali note e cost noto.
    const [gen] = await db
      .insert(docGenerations)
      .values({
        repositoryId,
        status: "succeeded",
        model: "opus",
        commitSha: upstream.fromSha,
        cost: "1.500000",
        stats: { nodes: 3, doneNodes: 3, failedNodes: 0, maxDepth: 1, pages: 1, chunks: 4 },
      })
      .returning();
    const generationId = gen!.id;
    await db.insert(docPages).values({
      repositoryId,
      generationId,
      kind: "technical",
      slug: "app-module",
      title: "App Module",
      sourcePath: "src",
      body: "Pagina app.",
    });
    await db
      .update(repositories)
      .set({ currentDocGenerationId: generationId })
      .where(eq(repositories.id, repositoryId));

    const runner = new FakeAgentRunner({
      script: (call: { prompt: string }): AgentRunResult => {
        if (isGrowOrientPrompt(call.prompt)) {
          return {
            output: growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }),
            exitCode: 0,
            usage: { totalCostUsd: 0.2, models: [] },
          };
        }
        if (isExplorePrompt(call.prompt)) {
          return {
            output: exploreOutput({ paths: ["billing"] }),
            exitCode: 0,
            usage: { totalCostUsd: 0.3, models: [] },
          };
        }
        return { output: SIGNIFICANT_OUTPUT, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g7",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    const [updated] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.id, generationId));
    const stats = updated?.stats as { pages: number; chunks: number };
    // pages incrementata di 1 (una pagina creata).
    expect(stats.pages).toBe(2);
    // chunks incrementati (>4: il body genera almeno un chunk).
    expect(stats.chunks).toBeGreaterThan(4);
    // cost = 1.5 (base) + 0.2 (orient) + 0.3 (explore) = 2.0.
    expect(Number(updated?.cost)).toBeCloseTo(2.0, 5);
  });

  it("release note: blocco pagine create presente + cross-link della entry include la pagina creata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream({
      extraFiles: { "billing/a.ts": "export const a = 1;\n", "billing/b.ts": "export const b = 2;\n" },
    });
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);
    await seedGenerationWithPages(db, repositoryId, upstream.fromSha, [
      { slug: "app-module", title: "App Module", sourcePath: "src", body: "Pagina app." },
    ]);

    // La release cita lo slug creato tra gli AFFECTED SLUGS: deve risultare cross-linkato
    // (il lookup è esteso alle pagine create).
    const releaseCitingCreated = [
      RELEASE_START_MARKER,
      "SIGNIFICANT: true",
      "TITLE: Novità fatturazione",
      RELEASE_SLUGS_START_MARKER,
      "- fatturazione",
      RELEASE_SLUGS_END_MARKER,
      RELEASE_BODY_START_MARKER,
      "## Aggiunto\n- nuova sezione fatturazione",
      RELEASE_BODY_END_MARKER,
      RELEASE_END_MARKER,
    ].join("\n");

    let releasePrompt = "";
    const runner = new FakeAgentRunner({
      script: (call: { prompt: string }): AgentRunResult => {
        if (isGrowOrientPrompt(call.prompt)) {
          return { output: growProposal({ title: "Fatturazione", kind: "functional", paths: "billing" }), exitCode: 0 };
        }
        if (isExplorePrompt(call.prompt)) return { output: exploreOutput({ paths: ["billing"] }), exitCode: 0 };
        releasePrompt = call.prompt;
        return { output: releaseCitingCreated, exitCode: 0 };
      },
    });
    await runAutoUpdate(baseDeps(db, mirrors, runner, { maxNewPages: 5 }), {
      id: "job-g8",
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
    });

    // Il prompt release ha ricevuto il blocco delle pagine create.
    expect(releasePrompt).toContain("DOCUMENTATION PAGES CREATED FOR NEW AREAS");
    expect(releasePrompt).toContain("fatturazione :: Fatturazione");

    // La entry release ha il cross-link verso la pagina creata.
    const [release] = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    const links = (release?.links ?? []) as { type: string; slug: string; title: string }[];
    expect(links.some((l) => l.slug === "fatturazione" && l.title === "Fatturazione")).toBe(true);
  });
});

describe("pollAutoUpdateOnce", () => {
  it("reclama solo i pending scaduti (not_before <= now), non quelli futuri, e li rimuove", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    // Un pending scaduto (not_before nel passato).
    await db.insert(docAutoUpdateJobs).values({
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
      notBefore: new Date(Date.now() - 60_000),
    });

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    const serializer = createProjectSerializer();
    const claimed = await pollAutoUpdateOnce({
      ...baseDeps(db, mirrors, runner),
      serializer,
    });
    expect(claimed).toBe(1);

    // Pending rimosso (reclamato), entry creata.
    const remaining = await db.select().from(docAutoUpdateJobs);
    expect(remaining).toHaveLength(0);
    const releases = await db
      .select()
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
    expect(releases).toHaveLength(1);
  });

  it("NON reclama un pending con not_before futuro", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream.url);

    await db.insert(docAutoUpdateJobs).values({
      repositoryId,
      fromSha: upstream.fromSha,
      toSha: upstream.toSha,
      notBefore: new Date(Date.now() + 5 * 60_000),
    });

    const runner = new FakeAgentRunner({ script: () => ({ output: SIGNIFICANT_OUTPUT, exitCode: 0 }) });
    const claimed = await pollAutoUpdateOnce({
      ...baseDeps(db, mirrors, runner),
      serializer: createProjectSerializer(),
    });
    expect(claimed).toBe(0);
    expect(runner.calls).toHaveLength(0);
    // Pending ancora presente (non reclamato).
    const remaining = await db
      .select()
      .from(docAutoUpdateJobs)
      .where(eq(docAutoUpdateJobs.repositoryId, repositoryId));
    expect(remaining).toHaveLength(1);
  });
});
