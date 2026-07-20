import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import type { EmbeddingProvider } from "./docs-retrieval.js";
import { retrieveChunks, retrieveChunksAll, retrieveChunksForProject } from "./docs-retrieval.js";
import { docChunks, docGenerations, docPages, gitAccounts, projects, repositories } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

// Fake embedding provider DETERMINISTICO e senza rete (replica di
// `createFakeEmbeddingClient` di @stubwise/embeddings, FNV-1a → xorshift32): per
// un testo identico il vettore è identico → distanza coseno 0 → quel chunk ranka
// primo. È così che rendiamo "semanticamente vicino" deterministico. Inlinato qui
// per NON accoppiare i test di @stubwise/db al package embeddings — stesso motivo
// per cui il retrieval usa il tipo strutturale `EmbeddingProvider`.
const EMBEDDING_DIMENSION = 1024;

/** Hash deterministico FNV-1a 32-bit, stabile tra run/processi. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const embeddingClient: EmbeddingProvider = {
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((text) => {
      // seed != 0 (xorshift degenera su 0).
      let state = fnv1a(text) || 1;
      const vector = new Array<number>(EMBEDDING_DIMENSION);
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        vector[i] = (state / 0x100000000) * 2 - 1;
      }
      return vector;
    });
  },
};

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
  page: {
    title: string;
    body: string;
    chunkContent: string;
    sourcePath?: string;
    slug?: string;
    kind?: "technical" | "functional" | "manual" | "releases";
  },
): Promise<string> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: page.kind ?? (generationId === null ? "manual" : "technical"),
      slug: page.slug ?? `page-${pageSeq}`,
      title: page.title,
      body: page.body,
      sourcePath: page.sourcePath ?? null,
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

  it("repositoryIds: restringe alla whitelist, i chunk provengono SOLO dal repo abilitato", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(projectId, "Repo Beta");
    const genA = await seedGeneration(repoA.id);
    const genB = await seedGeneration(repoB.id);

    // Token comune ai due chunk: senza filtro il full-text li trova entrambi.
    const token = `wltok${randomUUID().slice(0, 8)}`;
    const contentA = `Il ${token} di Alfa gestisce l'autenticazione.`;
    const contentB = `Il ${token} di Beta gestisce la fatturazione.`;
    const slugA = await seedPageWithChunk(repoA.id, genA, {
      title: "Alfa",
      body: contentA,
      chunkContent: contentA,
    });
    const slugB = await seedPageWithChunk(repoB.id, genB, {
      title: "Beta",
      body: contentB,
      chunkContent: contentB,
    });

    // Whitelist su solo repoA: i risultati NON includono mai il repo B.
    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryIds: [repoA.id],
    });
    expect(res.some((r) => r.slug === slugA)).toBe(true);
    expect(res.some((r) => r.slug === slugB)).toBe(false);
    expect(res.every((r) => r.repositoryId === repoA.id)).toBe(true);
  });

  it("repositoryIds con id STALE (inesistente) è tollerato: intersezione, nessun errore", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const content = `Contenuto ${randomUUID().slice(0, 8)} di Alfa.`;
    const slugA = await seedPageWithChunk(repoA.id, genA, {
      title: "Alfa",
      body: content,
      chunkContent: content,
    });

    // Whitelist = repoA valido + un id che non esiste più: l'intersezione tiene A.
    const res = await retrieveChunksForProject(db, embeddingClient, projectId, content, {
      repositoryIds: [repoA.id, randomUUID()],
    });
    expect(res.some((r) => r.slug === slugA)).toBe(true);
    expect(res.every((r) => r.repositoryId === repoA.id)).toBe(true);
  });

  it("repositoryIds vuoto → [] (nessun repo abilitato)", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const content = `Contenuto ${randomUUID().slice(0, 8)} di Alfa.`;
    await seedPageWithChunk(repoA.id, genA, {
      title: "Alfa",
      body: content,
      chunkContent: content,
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, content, {
      repositoryIds: [],
    });
    expect(res).toEqual([]);
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

describe("retrieveChunksForProject (filtro paths/slugs per-repo)", () => {
  it("paths: prefisso di directory (confine /), esatto sì, sibling e prefisso-di-nome no", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    // Token comune così il full-text tocca ogni pagina indipendentemente dal path.
    const token = `pftok${randomUUID().slice(0, 8)}`;
    const mk = async (sourcePath: string) =>
      seedPageWithChunk(repoA.id, genA, {
        title: sourcePath,
        body: `Contenuto ${token} di ${sourcePath}.`,
        chunkContent: `Contenuto ${token} di ${sourcePath}.`,
        sourcePath,
      });
    const inside = await mk("apps/webapp/router.ts"); // sotto la dir → sì
    const exact = await mk("apps/webapp"); // il path esatto → sì
    const sibling = await mk("apps/admin/index.ts"); // altra dir → no
    const namePrefix = await mk("apps/webapp-admin/x.ts"); // confine / non rispettato → no

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/webapp"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(inside)).toBe(true);
    expect(slugs.has(exact)).toBe(true);
    expect(slugs.has(sibling)).toBe(false);
    expect(slugs.has(namePrefix)).toBe(false);
  });

  it("slugs: seleziona pagine manuali (sourcePath null) per slug esplicito", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    await seedGeneration(repoA.id);
    const token = `sltok${randomUUID().slice(0, 8)}`;
    const faqSlug = `faq-${randomUUID().slice(0, 8)}`;
    await seedPageWithChunk(repoA.id, null, {
      title: "FAQ",
      body: `Contenuto ${token} della faq.`,
      chunkContent: `Contenuto ${token} della faq.`,
      slug: faqSlug,
    });
    const otherSlug = `other-${randomUUID().slice(0, 8)}`;
    await seedPageWithChunk(repoA.id, null, {
      title: "Altro",
      body: `Contenuto ${token} di un'altra pagina manuale.`,
      chunkContent: `Contenuto ${token} di un'altra pagina manuale.`,
      slug: otherSlug,
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: [], slugs: [faqSlug] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(faqSlug)).toBe(true);
    expect(slugs.has(otherSlug)).toBe(false);
  });

  it("entry vuota (paths+slugs []) → fail-closed: niente da quel repo", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `emptytok${randomUUID().slice(0, 8)}`;
    await seedPageWithChunk(repoA.id, genA, {
      title: "Pagina",
      body: `Contenuto ${token} qualunque.`,
      chunkContent: `Contenuto ${token} qualunque.`,
      sourcePath: "apps/webapp/x.ts",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: [], slugs: [] } },
    });
    expect(res).toEqual([]);
  });

  it("repo in whitelist SENZA entry nel filtro → tutto quel repo passa come prima", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(projectId, "Repo Beta");
    const genA = await seedGeneration(repoA.id);
    const genB = await seedGeneration(repoB.id);
    const token = `mixtok${randomUUID().slice(0, 8)}`;
    // repoA filtrato su apps/webapp; repoB senza entry → nessun filtro path.
    const aInside = await seedPageWithChunk(repoA.id, genA, {
      title: "A inside",
      body: `Contenuto ${token} di A dentro.`,
      chunkContent: `Contenuto ${token} di A dentro.`,
      sourcePath: "apps/webapp/x.ts",
    });
    const aOutside = await seedPageWithChunk(repoA.id, genA, {
      title: "A outside",
      body: `Contenuto ${token} di A fuori.`,
      chunkContent: `Contenuto ${token} di A fuori.`,
      sourcePath: "apps/admin/x.ts",
    });
    const bAny = await seedPageWithChunk(repoB.id, genB, {
      title: "B any",
      body: `Contenuto ${token} di B qualunque.`,
      chunkContent: `Contenuto ${token} di B qualunque.`,
      sourcePath: "packages/whatever/y.ts",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/webapp"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(aInside)).toBe(true);
    expect(slugs.has(aOutside)).toBe(false);
    expect(slugs.has(bAny)).toBe(true); // B senza entry → passa tutto
  });

  it("opzione assente → identico a oggi (nessun filtro path/slug)", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `notok${randomUUID().slice(0, 8)}`;
    const s1 = await seedPageWithChunk(repoA.id, genA, {
      title: "P1",
      body: `Contenuto ${token} uno.`,
      chunkContent: `Contenuto ${token} uno.`,
      sourcePath: "apps/webapp/x.ts",
    });
    const s2 = await seedPageWithChunk(repoA.id, genA, {
      title: "P2",
      body: `Contenuto ${token} due.`,
      chunkContent: `Contenuto ${token} due.`,
      sourcePath: "apps/admin/x.ts",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token);
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(s1)).toBe(true);
    expect(slugs.has(s2)).toBe(true);
  });

  it("escape LIKE: `_` e `%` nel prefisso sono trattati come literal", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `esctok${randomUUID().slice(0, 8)}`;
    const mk = async (sourcePath: string) =>
      seedPageWithChunk(repoA.id, genA, {
        title: sourcePath,
        body: `Contenuto ${token} di ${sourcePath}.`,
        chunkContent: `Contenuto ${token} di ${sourcePath}.`,
        sourcePath,
      });
    // `_` literal: `apps/we_bapp` deve matchare solo se stesso, non `apps/webbapp`.
    const literalUnderscore = await mk("apps/we_bapp/x.ts");
    const wouldWildcardUnderscore = await mk("apps/webbapp/x.ts");
    // `%` literal: un filtro `apps/we%` NON deve matchare `apps/webapp`.
    const percentSibling = await mk("apps/webapp/x.ts");

    const resUnderscore = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/we_bapp"], slugs: [] } },
    });
    const underSlugs = new Set(resUnderscore.map((r) => r.slug));
    expect(underSlugs.has(literalUnderscore)).toBe(true);
    expect(underSlugs.has(wouldWildcardUnderscore)).toBe(false);

    const resPercent = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/we%"], slugs: [] } },
    });
    const pctSlugs = new Set(resPercent.map((r) => r.slug));
    // `apps/we%` literal: non è prefisso-dir di nulla di seedato → niente match wildcard.
    expect(pctSlugs.has(percentSibling)).toBe(false);
    expect(pctSlugs.has(literalUnderscore)).toBe(false);
  });

  it("sourcePath di directory con slash finale NEL DB → coperto dal prefisso normalizzato", async () => {
    // Il docs-engine produce sourcePath di directory/radici con slash finale
    // (es. "audin-operator-sdk/"). Il client normalizza il prefisso salvato
    // (senza slash), quindi il DB riceve `paths: ["audin-operator-sdk"]`. Il
    // match `source_path LIKE p || '/%'` deve coprire ANCHE la riga directory
    // stessa "audin-operator-sdk/" (LIKE 'audin-operator-sdk/%').
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `slashdir${randomUUID().slice(0, 8)}`;
    const dirPage = await seedPageWithChunk(repoA.id, genA, {
      title: "SDK root",
      body: `Contenuto ${token} della radice sdk.`,
      chunkContent: `Contenuto ${token} della radice sdk.`,
      sourcePath: "audin-operator-sdk/",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["audin-operator-sdk"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(dirPage)).toBe(true);
  });

  it("pagina figlia sotto la directory → coperta dal prefisso normalizzato senza slash", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `slashchild${randomUUID().slice(0, 8)}`;
    const childPage = await seedPageWithChunk(repoA.id, genA, {
      title: "x controller",
      body: `Contenuto ${token} del controller x.`,
      chunkContent: `Contenuto ${token} del controller x.`,
      sourcePath: "audin-api/src/controllers/x.ts",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["audin-api/src/controllers"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(childPage)).toBe(true);
  });

  it("escape LIKE: un `%` LITERAL nel sourcePath è matchato dal prefisso corrispondente", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `pctlit${randomUUID().slice(0, 8)}`;
    // Pagina il cui sourcePath contiene un `%` letterale: il prefisso `apps/we%d`
    // deve matcharla (match esatto O sotto la dir), col `%` trattato come literal.
    const withPercent = await seedPageWithChunk(repoA.id, genA, {
      title: "con percento",
      body: `Contenuto ${token} con percento.`,
      chunkContent: `Contenuto ${token} con percento.`,
      sourcePath: "apps/we%d/router.ts",
    });
    // Sibling SENZA `%`: se il filtro trattasse `%` come wildcard, questa
    // matcherebbe pure — deve restare fuori.
    const wouldWildcard = await seedPageWithChunk(repoA.id, genA, {
      title: "senza percento",
      body: `Contenuto ${token} senza percento.`,
      chunkContent: `Contenuto ${token} senza percento.`,
      sourcePath: "apps/webad/router.ts",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/we%d"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(withPercent)).toBe(true);
    expect(slugs.has(wouldWildcard)).toBe(false);
  });

  it("kinds: seleziona l'intero gruppo del kind, gli altri kind restano fuori", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `kindtok${randomUUID().slice(0, 8)}`;
    const functionalSlug = await seedPageWithChunk(repoA.id, genA, {
      title: "Funzionale",
      body: `Contenuto ${token} funzionale.`,
      chunkContent: `Contenuto ${token} funzionale.`,
      sourcePath: "apps/webapp/f.ts",
      kind: "functional",
    });
    const technicalSlug = await seedPageWithChunk(repoA.id, genA, {
      title: "Tecnica",
      body: `Contenuto ${token} tecnica.`,
      chunkContent: `Contenuto ${token} tecnica.`,
      sourcePath: "apps/webapp/t.ts",
      kind: "technical",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: [], slugs: [], kinds: ["functional"] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    // Il gruppo functional passa PER INTERO, indipendentemente dal path; technical no.
    expect(slugs.has(functionalSlug)).toBe(true);
    expect(slugs.has(technicalSlug)).toBe(false);
  });

  it("kinds in OR con paths: una pagina FUORI dal path ma del kind giusto passa", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `orkind${randomUUID().slice(0, 8)}`;
    // Dentro il path, kind technical: passa via paths.
    const insidePath = await seedPageWithChunk(repoA.id, genA, {
      title: "Dentro path",
      body: `Contenuto ${token} dentro path.`,
      chunkContent: `Contenuto ${token} dentro path.`,
      sourcePath: "apps/webapp/x.ts",
      kind: "technical",
    });
    // FUORI dal path ma kind functional: deve passare via kinds (OR).
    const outsideButKind = await seedPageWithChunk(repoA.id, genA, {
      title: "Fuori path ma functional",
      body: `Contenuto ${token} fuori path.`,
      chunkContent: `Contenuto ${token} fuori path.`,
      sourcePath: "packages/altro/y.ts",
      kind: "functional",
    });
    // FUORI dal path E kind technical (non selezionato): deve restare fuori.
    const outsideAndOtherKind = await seedPageWithChunk(repoA.id, genA, {
      title: "Fuori path e technical",
      body: `Contenuto ${token} fuori e technical.`,
      chunkContent: `Contenuto ${token} fuori e technical.`,
      sourcePath: "packages/altro/z.ts",
      kind: "technical",
    });

    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: {
        [repoA.id]: { paths: ["apps/webapp"], slugs: [], kinds: ["functional"] },
      },
    });
    const slugs = new Set(res.map((r) => r.slug));
    expect(slugs.has(insidePath)).toBe(true); // via paths
    expect(slugs.has(outsideButKind)).toBe(true); // via kinds (OR)
    expect(slugs.has(outsideAndOtherKind)).toBe(false); // né path né kind
  });

  it("entry vecchia forma {paths,slugs} SENZA kinds → comportamento invariato", async () => {
    const projectId = await seedProject();
    const repoA = await seedRepoInProject(projectId, "Repo Alfa");
    const genA = await seedGeneration(repoA.id);
    const token = `legacytok${randomUUID().slice(0, 8)}`;
    const inside = await seedPageWithChunk(repoA.id, genA, {
      title: "Dentro",
      body: `Contenuto ${token} dentro.`,
      chunkContent: `Contenuto ${token} dentro.`,
      sourcePath: "apps/webapp/x.ts",
      kind: "functional",
    });
    const outside = await seedPageWithChunk(repoA.id, genA, {
      title: "Fuori",
      body: `Contenuto ${token} fuori.`,
      chunkContent: `Contenuto ${token} fuori.`,
      sourcePath: "apps/admin/x.ts",
      kind: "functional",
    });

    // Entry nella forma vecchia: NESSUN campo `kinds` (retrocompatibilità del jsonb).
    const res = await retrieveChunksForProject(db, embeddingClient, projectId, token, {
      repositoryFilters: { [repoA.id]: { paths: ["apps/webapp"], slugs: [] } },
    });
    const slugs = new Set(res.map((r) => r.slug));
    // Solo il match path resta: la gamba kinds assente non allarga nulla.
    expect(slugs.has(inside)).toBe(true);
    expect(slugs.has(outside)).toBe(false);
  });
});

describe("retrieveChunksAll (cross-repo GLOBALE)", () => {
  it("recupera da repo di progetti DIVERSI, entrambi rappresentati col repo corretto", async () => {
    // Due progetti distinti, un repo documentato ciascuno.
    const projectA = await seedProject();
    const projectB = await seedProject();
    const repoA = await seedRepoInProject(projectA, "Global Repo Alfa");
    const repoB = await seedRepoInProject(projectB, "Global Repo Beta");
    const genA = await seedGeneration(repoA.id);
    const genB = await seedGeneration(repoB.id);

    // Token univoco condiviso dai due chunk: il full-text lo trova in entrambi i
    // repo, quindi il risultato globale deve rappresentare ENTRAMBI i progetti.
    const token = `globtok${randomUUID().slice(0, 8)}`;
    const contentA = `Il ${token} di Alfa gestisce l'autenticazione.`;
    const contentB = `Il ${token} di Beta gestisce la fatturazione.`;
    const slugA = await seedPageWithChunk(repoA.id, genA, {
      title: "Alfa Globale",
      body: contentA,
      chunkContent: contentA,
    });
    const slugB = await seedPageWithChunk(repoB.id, genB, {
      title: "Beta Globale",
      body: contentB,
      chunkContent: contentB,
    });

    // `k` esplicito ampio: il DB testcontainer è condiviso e accumula chunk da
    // tutti i test; con il `k` di default un match full-text a basso score può
    // essere troncato via da match semantici (fake embedding) di corpus estraneo.
    const res = await retrieveChunksAll(db, embeddingClient, token, { k: 200 });
    const hitA = res.find((r) => r.slug === slugA);
    const hitB = res.find((r) => r.slug === slugB);
    expect(hitA).toBeDefined();
    expect(hitB).toBeDefined();
    expect(hitA!.repositoryId).toBe(repoA.id);
    expect(hitA!.repositoryName).toBe("Global Repo Alfa");
    expect(hitB!.repositoryId).toBe(repoB.id);
    expect(hitB!.repositoryName).toBe("Global Repo Beta");
  });

  it("filtro generazione PER-REPO: un chunk di generazione NON corrente è escluso", async () => {
    const projectA = await seedProject();
    const repoA = await seedRepoInProject(projectA, "Global Stale");
    // Generazione STALE (non corrente) con un match perfetto sul token.
    const staleGen = await seedGeneration(repoA.id, { current: false });
    const token = `globstale${randomUUID().slice(0, 8)}`;
    const staleContent = `Contenuto ${token} di una generazione stale globale.`;
    const staleSlug = await seedPageWithChunk(repoA.id, staleGen, {
      title: "Stale Globale",
      body: staleContent,
      chunkContent: staleContent,
    });
    // Generazione corrente, irrilevante al token.
    const currentGen = await seedGeneration(repoA.id);
    await seedPageWithChunk(repoA.id, currentGen, {
      title: "Current Globale",
      body: "Contenuto corrente qualunque.",
      chunkContent: "Contenuto corrente qualunque.",
    });

    const res = await retrieveChunksAll(db, embeddingClient, token);
    expect(res.some((r) => r.slug === staleSlug)).toBe(false);
  });

  it("include le pagine manuali (generationId NULL) globalmente", async () => {
    const projectA = await seedProject();
    const repoA = await seedRepoInProject(projectA, "Global Manual");
    await seedGeneration(repoA.id);
    const token = `globman${randomUUID().slice(0, 8)}`;
    const manualContent = `Procedura ${token} manuale globale.`;
    const manualSlug = await seedPageWithChunk(repoA.id, null, {
      title: "Manuale Globale",
      body: manualContent,
      chunkContent: manualContent,
    });

    // `k` esplicito ampio (vedi nota sopra): evita che il match full-text a basso
    // score sia troncato via dal corpus semantico estraneo del DB condiviso.
    const res = await retrieveChunksAll(db, embeddingClient, token, { k: 200 });
    const hit = res.find((r) => r.slug === manualSlug);
    expect(hit).toBeDefined();
    expect(hit!.repositoryId).toBe(repoA.id);
  });

  it("nessun repository (DB senza repo) → [] senza toccare embedding/query", async () => {
    // Il DB del testcontainer è condiviso e ha già repo seedati dagli altri test:
    // l'early-return `repos.length === 0` non è osservabile su `db`. Lo isoliamo
    // con uno stub minimale del select che ritorna una lista di repo vuota; se
    // l'early-return non scattasse, il retrieval proverebbe a usare db/embedding.
    const emptyDb = {
      select: () => ({ from: async () => [] }),
    } as unknown as Db;
    const res = await retrieveChunksAll(emptyDb, embeddingClient, "qualunque query");
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
