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
  REFRESH_NO_CHANGE_MARKER,
  REFRESH_UPDATED_END_MARKER,
  REFRESH_UPDATED_START_MARKER,
  RELEASE_BODY_END_MARKER,
  RELEASE_BODY_START_MARKER,
  RELEASE_END_MARKER,
  RELEASE_SLUGS_END_MARKER,
  RELEASE_SLUGS_START_MARKER,
  RELEASE_START_MARKER,
} from "@stubwise/docs-engine";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { and, eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { createRepositorySerializer } from "../handler.js";
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
      ingestionKey: `ingestion-au-${uniq}`,
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
  opts: { maxRefreshPages?: number } = {},
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
    const serializer = createRepositorySerializer();
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
      serializer: createRepositorySerializer(),
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
