import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import type { DocPageKind } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { docGenerations, docPages, repositories } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

async function insertProject(db: Db): Promise<{ id: string; slug: string }> {
  const { repositoryId } = await seedRepository(db);
  const [repository] = await db
    .select({ slug: repositories.slug })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return { id: repositoryId, slug: repository!.slug };
}

async function insertGeneration(
  db: Db,
  projectId: string,
  opts: { current?: boolean } = {},
): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      repositoryId: projectId,
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
      .where(eq(repositories.id, projectId));
  }
  return gen.id;
}

let pageSeq = 0;

/** Inserisce una pagina; ritorna il suo id (per usarlo come parentId). */
async function insertPage(
  db: Db,
  projectId: string,
  generationId: string | null,
  page: {
    title: string;
    body: string;
    kind: DocPageKind;
    parentId?: string | null;
    position?: number;
    slug?: string;
  },
): Promise<string> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId: projectId,
      generationId,
      kind: page.kind,
      slug: page.slug ?? `page-${pageSeq}`,
      title: page.title,
      body: page.body,
      parentId: page.parentId ?? null,
      position: page.position ?? 0,
      isManual: generationId === null,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");
  return row.id;
}

function exportUrl(projectId: string, kind: string): string {
  return `/api/repositories/${projectId}/docs/export?kind=${kind}`;
}

/** Scarica ed estrae lo ZIP: mappa path → contenuto testuale. */
async function fetchZipEntries(
  projectId: string,
  kind: string,
  cookie: string,
): Promise<Record<string, string>> {
  const res = await app.inject({ method: "GET", url: exportUrl(projectId, kind), headers: { cookie } });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("application/zip");
  const disp = res.headers["content-disposition"];
  expect(disp).toContain("attachment;");
  expect(disp).toContain(`-${kind}-docs.zip`);
  const files = unzipSync(new Uint8Array(res.rawPayload));
  const out: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) out[path] = strFromU8(bytes);
  return out;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("GET /api/repositories/:repositoryId/docs/export", () => {
  it("un nodo padre diventa cartella con index.md e i figli dentro, ordinati per position", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);

    const rootId = await insertPage(testDb.db, project.id, genId, {
      title: "Root Page",
      body: "# Root Page\n\nCorpo della root.",
      kind: "technical",
      position: 0,
    });
    // Due figli con position invertita rispetto all'inserimento: l'ordine dello
    // zip deve seguire position (Child A prima di Child B).
    await insertPage(testDb.db, project.id, genId, {
      title: "Child B",
      body: "Corpo del figlio B.",
      kind: "technical",
      parentId: rootId,
      position: 1,
    });
    await insertPage(testDb.db, project.id, genId, {
      title: "Child A",
      body: "Corpo del figlio A.",
      kind: "technical",
      parentId: rootId,
      position: 0,
    });

    const entries = await fetchZipEntries(project.id, "technical", memberCookie);
    const paths = Object.keys(entries).sort();

    // Il padre è una cartella con index.md; i figli sono foglie dentro, con
    // prefisso numerico che riflette position (01 = Child A, 02 = Child B).
    expect(paths).toEqual([
      "01-Root-Page/01-Child-A.md",
      "01-Root-Page/02-Child-B.md",
      "01-Root-Page/index.md",
    ]);
    // Contenuti corretti (body preservato).
    expect(entries["01-Root-Page/index.md"]).toContain("Corpo della root.");
    expect(entries["01-Root-Page/01-Child-A.md"]).toContain("Corpo del figlio A.");
    expect(entries["01-Root-Page/02-Child-B.md"]).toContain("Corpo del figlio B.");
    // Body senza heading iniziale → viene anteposto "# <title>".
    expect(entries["01-Root-Page/01-Child-A.md"]!.startsWith("# Child A\n\n")).toBe(true);
    // Body già con heading → non viene duplicato.
    expect(entries["01-Root-Page/index.md"]!.startsWith("# Root Page\n\n")).toBe(true);
  });

  it("più radici sono ordinate per position con prefisso numerico", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);
    await insertPage(testDb.db, project.id, genId, {
      title: "Secondo",
      body: "b",
      kind: "functional",
      position: 1,
    });
    await insertPage(testDb.db, project.id, genId, {
      title: "Primo",
      body: "a",
      kind: "functional",
      position: 0,
    });

    const entries = await fetchZipEntries(project.id, "functional", memberCookie);
    expect(Object.keys(entries).sort()).toEqual(["01-Primo.md", "02-Secondo.md"]);
  });

  it("esporta solo il kind richiesto (le altre categorie sono escluse)", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);
    await insertPage(testDb.db, project.id, genId, {
      title: "Tech Only",
      body: "t",
      kind: "technical",
    });
    await insertPage(testDb.db, project.id, genId, {
      title: "Func Only",
      body: "f",
      kind: "functional",
    });

    const entries = await fetchZipEntries(project.id, "technical", memberCookie);
    expect(Object.keys(entries)).toEqual(["01-Tech-Only.md"]);
    expect(entries["01-Tech-Only.md"]).toContain("t");
  });

  it("include le manuali (generationId null) ed esclude le generazioni stale", async () => {
    const project = await insertProject(testDb.db);
    const staleGen = await insertGeneration(testDb.db, project.id, { current: false });
    await insertPage(testDb.db, project.id, staleGen, {
      title: "Stale Page",
      body: "stale",
      kind: "technical",
    });
    const currentGen = await insertGeneration(testDb.db, project.id);
    await insertPage(testDb.db, project.id, currentGen, {
      title: "Current Page",
      body: "current",
      kind: "technical",
    });
    // Manuale con kind technical (generationId null) → deve comparire.
    await insertPage(testDb.db, project.id, null, {
      title: "Manual Tech",
      body: "manual",
      kind: "technical",
    });

    const entries = await fetchZipEntries(project.id, "technical", memberCookie);
    const joined = Object.keys(entries).join("|");
    expect(joined).toContain("Current-Page");
    expect(joined).toContain("Manual-Tech");
    expect(joined).not.toContain("Stale-Page");
  });

  it("sanifica i titoli: uno slash nel titolo NON crea sottocartelle impreviste", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);
    await insertPage(testDb.db, project.id, genId, {
      title: "a/b: c*d?",
      body: "x",
      kind: "manual",
      slug: "sane-slug",
    });

    const entries = await fetchZipEntries(project.id, "manual", memberCookie);
    const paths = Object.keys(entries);
    // Un solo file, foglia: niente `/` extra, niente `..`, niente path assoluto.
    expect(paths).toHaveLength(1);
    const p = paths[0]!;
    expect(p.endsWith(".md")).toBe(true);
    expect(p.includes("/")).toBe(false);
    expect(p.includes("..")).toBe(false);
    expect(p.startsWith("/")).toBe(false);
  });

  it("kind senza pagine: 404", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);
    await insertPage(testDb.db, project.id, genId, {
      title: "Solo technical",
      body: "x",
      kind: "technical",
    });
    // Nessuna pagina releases.
    const res = await app.inject({
      method: "GET",
      url: exportUrl(project.id, "releases"),
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("kind non valido: 400 (validazione Zod)", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: exportUrl(project.id, "bogus"),
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("repository inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: exportUrl(randomUUID(), "technical"),
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({ method: "GET", url: exportUrl(project.id, "technical") });
    expect(res.statusCode).toBe(401);
  });
});
