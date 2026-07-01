import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { retrieveChunks, retrieveChunksForProject } from "./docs-retrieval.js";
import {
  docChunks,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  repositories,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";

// Stesso fake client deterministico (hash → vettore) usato dai test docs: per un
// testo identico il vettore è identico → distanza coseno 0 → quel chunk ranka
// primo. È così che rendiamo "semanticamente vicino" deterministico.
const embeddingClient = createFakeEmbeddingClient();

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Crea un progetto vuoto e ne restituisce l'id. */
async function seedProject(): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ name: "Progetto", slug: `progetto-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

/** Crea un repository nel progetto dato e ne restituisce id/slug/name. */
async function seedRepoInProject(
  projectId: string,
  name: string,
): Promise<{ id: string; slug: string; name: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: "blob",
    })
    .returning();
  const slug = `repo-${randomUUID()}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId,
      name,
      slug,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
    })
    .returning();
  if (!repo) throw new Error("insert del repository non ha restituito la riga");
  return { id: repo.id, slug, name };
}

/** Generazione succeeded; se `current` la imposta come corrente del repo. */
async function seedGeneration(
  repositoryId: string,
  opts: { current?: boolean } = {},
): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      repositoryId,
      status: "succeeded",
      commitSha: randomBytes(4).toString("hex"),
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  if (opts.current !== false) {
    await db
      .update(repositories)
      .set({ currentDocGenerationId: gen.id })
      .where(eq(repositories.id, repositoryId));
  }
  return gen.id;
}

let pageSeq = 0;

/** Pagina + chunk il cui embedding è quello del contenuto (fake client). */
async function seedPageWithChunk(
  repositoryId: string,
  generationId: string | null,
  page: { title: string; body: string; chunkContent: string },
): Promise<string> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: generationId === null ? "manual" : "technical",
      slug: `page-${pageSeq}`,
      title: page.title,
      body: page.body,
      isManual: generationId === null,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");
  const [vector] = await embeddingClient.embed([page.chunkContent]);
  await db.insert(docChunks).values({
    pageId: row.id,
    repositoryId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return row.slug;
}

describe("retrieveChunksForProject (cross-repo)", () => {
  it("recupera da DUE repo dello stesso progetto, entrambi rappresentati col repo corretto", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(projectId, "Repo Beta");
    const genA = await seedGeneration(repoA.id);
    const genB = await seedGeneration(repoB.id);

    // Query = testo che combina i due chunk; ogni chunk è vicino al proprio testo.
    const contentA = "Il modulo di autenticazione di Alfa usa cookie firmati.";
    const contentB = "Il modulo di fatturazione di Beta calcola le imposte.";
    const slugA = await seedPageWithChunk(repoA.id, genA, {
      title: "Auth Alfa",
      body: "Pagina auth.",
      chunkContent: contentA,
    });
    const slugB = await seedPageWithChunk(repoB.id, genB, {
      title: "Billing Beta",
      body: "Pagina billing.",
      chunkContent: contentB,
    });

    // Due query separate, una per repo: ciascuna deve recuperare il proprio chunk
    // col repository d'origine corretto.
    const resA = await retrieveChunksForProject(db, embeddingClient, projectId, contentA);
    const hitA = resA.find((r) => r.slug === slugA);
    expect(hitA).toBeDefined();
    expect(hitA!.repositoryId).toBe(repoA.id);
    expect(hitA!.repositoryName).toBe("Repo Alfa");
    expect(hitA!.repositorySlug).toBe(repoA.slug);

    const resB = await retrieveChunksForProject(db, embeddingClient, projectId, contentB);
    const hitB = resB.find((r) => r.slug === slugB);
    expect(hitB).toBeDefined();
    expect(hitB!.repositoryId).toBe(repoB.id);
    expect(hitB!.repositoryName).toBe("Repo Beta");

    // Una query che le tocca entrambe (full-text sui token comuni "modulo") deve
    // poter rappresentare ENTRAMBI i repo nello stesso risultato.
    const both = await retrieveChunksForProject(db, embeddingClient, projectId, "modulo");
    const repoIds = new Set(both.map((r) => r.repositoryId));
    expect(repoIds.has(repoA.id)).toBe(true);
    expect(repoIds.has(repoB.id)).toBe(true);
  });

  it("filtro generazione PER-REPO: il chunk di una generazione STALE di un repo NON compare", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(projectId, "Repo Beta");

    // repoA: una generazione STALE (non corrente) con un match perfetto + una
    // corrente con una pagina qualunque.
    const staleGen = await seedGeneration(repoA.id, { current: false });
    const staleContent = "Contenuto stale che non deve uscire dal retrieval cross-repo.";
    const staleSlug = await seedPageWithChunk(repoA.id, staleGen, {
      title: "Stale Alfa",
      body: staleContent,
      chunkContent: staleContent,
    });
    const currentGenA = await seedGeneration(repoA.id);
    await seedPageWithChunk(repoA.id, currentGenA, {
      title: "Current Alfa",
      body: "Contenuto corrente di Alfa.",
      chunkContent: "Contenuto corrente di Alfa qualunque.",
    });

    // repoB: solo una generazione corrente, irrilevante alla query.
    const genB = await seedGeneration(repoB.id);
    await seedPageWithChunk(repoB.id, genB, {
      title: "Beta",
      body: "Contenuto di Beta.",
      chunkContent: "Contenuto di Beta qualunque.",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, staleContent);
    // Pur essendo un match perfetto, la pagina stale di repoA NON compare: lo
    // scope OR-di-coppie filtra la generazione corrente PER-REPO.
    expect(res.some((r) => r.slug === staleSlug)).toBe(false);
  });

  it("include le pagine manuali (generationId NULL) cross-repo", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    await seedGeneration(repoA.id);
    const manualContent = "Procedura manuale condivisa di onboarding del progetto.";
    const manualSlug = await seedPageWithChunk(repoA.id, null, {
      title: "Onboarding",
      body: manualContent,
      chunkContent: manualContent,
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, manualContent);
    const hit = res.find((r) => r.slug === manualSlug);
    expect(hit).toBeDefined();
    expect(hit!.repositoryId).toBe(repoA.id);
  });

  it("progetto senza repo documentati → []", async () => {
    // Progetto con un repo MA senza alcuna generazione corrente né pagina manuale.
    const projectId = await seedProject();
    await seedRepoInProject(projectId, "Repo Vuoto");
    const res = await retrieveChunksForProject(db, embeddingClient, projectId, "qualunque query");
    expect(res).toEqual([]);
  });

  it("progetto senza alcun repository → []", async () => {
    const projectId = await seedProject();
    const res = await retrieveChunksForProject(db, embeddingClient, projectId, "qualunque query");
    expect(res).toEqual([]);
  });
});

describe("retrieveChunks (per-repo): campi repository popolati", () => {
  it("ogni risultato porta repositoryId/slug/name del repo, semantica invariata", async () => {
    const projectId = await seedProject();
    const repo = await seedRepoInProject(projectId, "Repo Solo");
    const gen = await seedGeneration(repo.id);
    const content = "L'autenticazione usa cookie di sessione firmati e argon2.";
    const slug = await seedPageWithChunk(repo.id, gen, {
      title: "Auth",
      body: "Pagina auth.",
      chunkContent: content,
    });

    const res = await retrieveChunks(db, embeddingClient, repo.id, content);
    expect(res[0]!.slug).toBe(slug);
    // Match esatto del chunk = score semantico massimo (semantica invariata).
    expect(res[0]!.score).toBeGreaterThan(0.99);
    expect(res[0]!.repositoryId).toBe(repo.id);
    expect(res[0]!.repositorySlug).toBe(repo.slug);
    expect(res[0]!.repositoryName).toBe("Repo Solo");
  });
});
