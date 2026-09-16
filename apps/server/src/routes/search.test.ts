import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import {
  comments,
  docGenerations,
  docPages,
  emailMessages,
  googleAccounts,
  googleWorkspaces,
  projects,
  repositories,
  searchHistory,
  tickets,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import {
  seedRepository,
  seedTicket,
  startTestDb,
} from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const embeddingClient = createFakeEmbeddingClient();

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let adminId: string;

/** Crea una generazione corrente per un repo e restituisce il suo id. */
async function currentGeneration(db: Db, repositoryId: string): Promise<string> {
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
  await db
    .update(repositories)
    .set({ currentDocGenerationId: gen!.id })
    .where(eq(repositories.id, repositoryId));
  return gen!.id;
}

let pageSeq = 0;
async function insertDocPage(
  db: Db,
  repositoryId: string,
  generationId: string,
  page: { title: string; body: string; kind?: "technical" | "functional" | "manual" },
): Promise<string> {
  pageSeq++;
  const slug = `page-${pageSeq}`;
  await db.insert(docPages).values({
    repositoryId,
    generationId,
    kind: page.kind ?? "technical",
    slug,
    title: page.title,
    body: page.body,
  });
  return slug;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
  });
  ({ adminCookie, memberCookie, memberId, adminId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface SearchResponse {
  tickets: { items: { id: string; title: string; projectName: string; snippet: string }[]; hasMore: boolean };
  projects: { items: { id: string; name: string; slug: string; snippet: string | null }[]; hasMore: boolean };
  repositories: { items: { id: string; slug: string; projectId: string }[]; hasMore: boolean };
  docs: { items: { slug: string; title: string; repositoryId: string; snippet: string }[]; hasMore: boolean };
  mail: {
    items: {
      threadId: string;
      accountId: string;
      accountEmail: string;
      subject: string | null;
      from: string;
      snippet: string;
      matchedMessageId: string;
      receivedAt: string;
    }[];
    hasMore: boolean;
  };
}

/**
 * Una casella Google collegata a un utente, e i messaggi dentro.
 *
 * Serve ai test dell'ACL della posta: l'unico modo di verificare che la
 * ricerca non attraversi il confine fra due caselle è averne due, di due
 * utenti diversi.
 */
async function seedMailbox(userId: string): Promise<{ accountId: string; email: string }> {
  const [workspace] = await testDb.db
    .insert(googleWorkspaces)
    .values({
      name: "Acme",
      domains: ["acme.test"],
      clientId: "client-id",
      clientSecretEncrypted: "blob",
    })
    .returning({ id: googleWorkspaces.id });
  const email = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await testDb.db
    .insert(googleAccounts)
    .values({
      userId,
      workspaceId: workspace!.id,
      email,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  return { accountId: account!.id, email };
}

async function seedMessage(
  accountId: string,
  overrides: Partial<typeof emailMessages.$inferInsert> = {},
): Promise<string> {
  const [row] = await testDb.db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId: `g-${randomUUID()}`,
      threadId: `t-${randomUUID()}`,
      fromAddress: "cliente@acme.test",
      subject: "Un oggetto qualunque",
      textExcerpt: "Un corpo qualunque",
      receivedAt: new Date("2026-09-15T09:00:00.000Z"),
      ...overrides,
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

async function search(q: string, cookie = memberCookie, scope?: string): Promise<SearchResponse> {
  const url = `/api/search?q=${encodeURIComponent(q)}${scope ? `&repositoryId=${scope}` : ""}`;
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as SearchResponse;
}

describe("GET /api/search", () => {
  it("trova un ticket per un token del titolo (cross-progetto, con nome progetto)", async () => {
    const { projectId, ticketId } = await seedTicket(testDb.db);
    const token = `Zorbaxtitle${randomUUID().slice(0, 6)}`;
    await testDb.db.update(tickets).set({ title: `${token} problema di login` }).where(eq(tickets.id, ticketId));
    const [project] = await testDb.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));

    const body = await search(token);
    const hit = body.tickets.items.find((t) => t.id === ticketId);
    expect(hit).toBeDefined();
    expect(hit!.projectName).toBe(project!.name);
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });

  it("trova un ticket per un token del BODY", async () => {
    const { ticketId } = await seedTicket(testDb.db);
    const token = `Bodyxtoken${randomUUID().slice(0, 6)}`;
    await testDb.db.update(tickets).set({ body: `descrizione con ${token} dentro` }).where(eq(tickets.id, ticketId));

    const body = await search(token);
    expect(body.tickets.items.some((t) => t.id === ticketId)).toBe(true);
  });

  it("trova un ticket per un token in un COMMENTO", async () => {
    const { ticketId } = await seedTicket(testDb.db);
    const token = `Commentxtoken${randomUUID().slice(0, 6)}`;
    await testDb.db.insert(comments).values({
      ticketId,
      authorType: "user",
      authorId: memberId,
      body: `un commento che parla di ${token}`,
    });

    const body = await search(token);
    expect(body.tickets.items.some((t) => t.id === ticketId)).toBe(true);
  });

  it("trova un progetto per nome/slug (case-insensitive)", async () => {
    const token = `zprojname${randomUUID().slice(0, 6)}`;
    const [project] = await testDb.db
      .insert(projects)
      .values({ name: `Progetto ${token}`, slug: `slug-${token}`, ingestionKey: randomUUID() })
      .returning();

    // Match per nome (uppercase → verifica case-insensitive).
    const byName = await search(token.toUpperCase());
    expect(byName.projects.items.some((p) => p.id === project!.id)).toBe(true);
    // Match per slug.
    const bySlug = await search(`slug-${token}`);
    expect(bySlug.projects.items.some((p) => p.id === project!.id)).toBe(true);
  });

  it("trova un repository per slug", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    const [repo] = await testDb.db
      .select({ slug: repositories.slug })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));

    const body = await search(repo!.slug);
    expect(body.repositories.items.some((r) => r.id === repositoryId)).toBe(true);
  });

  it("trova una pagina doc per full-text (generazione corrente)", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    const genId = await currentGeneration(testDb.db, repositoryId);
    const token = `Docxtoken${randomUUID().slice(0, 6)}`;
    const slug = await insertDocPage(testDb.db, repositoryId, genId, {
      title: `${token} Reference`,
      body: `Contenuto sul modulo ${token}.`,
    });

    const body = await search(token);
    const hit = body.docs.items.find((d) => d.slug === slug);
    expect(hit).toBeDefined();
    expect(hit!.repositoryId).toBe(repositoryId);
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });

  it("le pagine di generazioni STALE non compaiono nei doc", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    // Generazione stale (non corrente).
    const [staleGen] = await testDb.db
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
    const token = `Stalexdoc${randomUUID().slice(0, 6)}`;
    const staleSlug = await insertDocPage(testDb.db, repositoryId, staleGen!.id, {
      title: `${token} stale`,
      body: `Contenuto stale ${token}.`,
    });
    // Poi la generazione corrente (senza il token).
    await currentGeneration(testDb.db, repositoryId);

    const body = await search(token);
    expect(body.docs.items.some((d) => d.slug === staleSlug)).toBe(false);
  });

  it("scope Docs ristringe SOLO i doc a quel repo; gli altri gruppi restano globali", async () => {
    const token = `Scopetok${randomUUID().slice(0, 6)}`;
    // Due repo con una pagina doc ciascuno che matcha il token.
    const { repositoryId: repoA, projectId: projectA } = await seedRepository(testDb.db);
    const genA = await currentGeneration(testDb.db, repoA);
    const slugA = await insertDocPage(testDb.db, repoA, genA, { title: `${token} A`, body: `doc ${token} in A` });
    const { repositoryId: repoB } = await seedRepository(testDb.db);
    const genB = await currentGeneration(testDb.db, repoB);
    const slugB = await insertDocPage(testDb.db, repoB, genB, { title: `${token} B`, body: `doc ${token} in B` });
    // Un ticket globale che matcha lo stesso token (gruppo ticket resta globale).
    const { ticketId } = await seedTicket(testDb.db, { projectId: projectA });
    await testDb.db.update(tickets).set({ title: `${token} ticket globale` }).where(eq(tickets.id, ticketId));

    const scoped = await search(token, memberCookie, repoA);
    const docSlugs = scoped.docs.items.map((d) => d.slug);
    // Solo i doc di repoA; quelli di repoB esclusi.
    expect(docSlugs).toContain(slugA);
    expect(docSlugs).not.toContain(slugB);
    // Ticket globale ancora presente pur essendo in scope Docs.
    expect(scoped.tickets.items.some((t) => t.id === ticketId)).toBe(true);
  });

  it("raggruppa con hasMore quando un gruppo supera la finestra (progetti)", async () => {
    const token = `manyproj${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 10; i++) {
      await testDb.db
        .insert(projects)
        .values({ name: `Proj ${token} ${i}`, slug: `s-${token}-${i}`, ingestionKey: randomUUID() });
    }
    const body = await search(token);
    expect(body.projects.items.length).toBe(8);
    expect(body.projects.hasMore).toBe(true);
  });

  it("q vuota (soli spazi): 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/search?q=${encodeURIComponent("   ")}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("q assente: 400 (validazione Zod)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=ciao" });
    expect(res.statusCode).toBe(401);
  });
});

interface DocSemanticHit {
  slug: string;
  title: string;
  kind: string;
  snippet: string;
  repositoryId: string;
  repositorySlug: string;
  repositoryName: string;
  score: number;
}

async function docsSemantic(
  q: string,
  cookie = memberCookie,
  scope?: string,
): Promise<DocSemanticHit[]> {
  const url = `/api/search/docs-semantic?q=${encodeURIComponent(q)}${scope ? `&repositoryId=${scope}` : ""}`;
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as DocSemanticHit[];
}

// ---------------------------------------------------------------------------
// La POSTA (15 set 2026, design §3). L'ACL è la parte che non può sbagliare.
// ---------------------------------------------------------------------------

describe("GET /api/search — la posta", () => {
  it("trova una CONVERSAZIONE per un token dell'oggetto, e dice quale messaggio ha combaciato", async () => {
    const { accountId, email } = await seedMailbox(memberId);
    const token = `Fatturaxxx${randomUUID().slice(0, 6)}`;
    const threadId = `thread-${randomUUID()}`;
    const messageId = await seedMessage(accountId, {
      threadId,
      subject: `${token} da rivedere`,
    });

    const body = await search(token);
    expect(body.mail.items).toHaveLength(1);
    const [hit] = body.mail.items;
    expect(hit!.threadId).toBe(threadId);
    expect(hit!.matchedMessageId).toBe(messageId);
    expect(hit!.accountEmail).toBe(email);
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });

  it("trova una conversazione per un token dell'ESTRATTO e per il MITTENTE", async () => {
    const { accountId } = await seedMailbox(memberId);
    const bodyToken = `Corpoxxx${randomUUID().slice(0, 6)}`;
    const senderToken = `mittentexxx${randomUUID().slice(0, 6)}`;
    await seedMessage(accountId, { textExcerpt: `un testo con ${bodyToken} dentro` });
    await seedMessage(accountId, { fromAddress: `${senderToken}@acme.test` });

    expect((await search(bodyToken)).mail.items).toHaveLength(1);
    expect((await search(senderToken)).mail.items).toHaveLength(1);
  });

  it("⚠️ UNA RIGA PER CONVERSAZIONE, non una per messaggio", async () => {
    // È il modello che «la posta si legge per conversazione» ha tolto: tre
    // risposte dello stesso scambio non sono tre risultati.
    const { accountId } = await seedMailbox(memberId);
    const token = `Scambioxxx${randomUUID().slice(0, 6)}`;
    const threadId = `thread-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await seedMessage(accountId, {
        threadId,
        subject: `Re: ${token}`,
        receivedAt: new Date(`2026-09-1${i + 1}T09:00:00.000Z`),
      });
    }

    const body = await search(token);
    expect(body.mail.items).toHaveLength(1);
    expect(body.mail.items[0]!.threadId).toBe(threadId);
  });

  it("i messaggi di CONTESTO (`admitted: false`) sono cercabili: cercare è leggere", async () => {
    // Quel limite esiste perché un messaggio di contesto non diventi mai una
    // CARD, non perché non si possa leggere — ed escluderlo lascerebbe buchi
    // in conversazioni che la pagina Posta mostra per intero.
    const { accountId } = await seedMailbox(memberId);
    const token = `Contestoxxx${randomUUID().slice(0, 6)}`;
    await seedMessage(accountId, { admitted: false, subject: `${token} nel contesto` });

    expect((await search(token)).mail.items).toHaveLength(1);
  });

  it("⚠️ LA POSTA DI UN ALTRO UTENTE NON COMPARE — nemmeno per un admin", async () => {
    // ⚠️ Il test NEGATIVO che conta: la parola cercata esiste SOLO nel
    // messaggio dell'altro utente, quindi un risultato vuoto non può essere
    // un caso — se l'ACL cadesse, quella riga sarebbe l'unica a comparire.
    // Contare i risultati non basterebbe: con due messaggi diversi un
    // conteggio giusto può nascondere la riga sbagliata.
    const { accountId: mineId } = await seedMailbox(memberId);
    const { accountId: theirsId } = await seedMailbox(adminId);
    const secret = `Segretoxxx${randomUUID().slice(0, 6)}`;
    await seedMessage(theirsId, { subject: `${secret} — riservato`, textExcerpt: secret });
    // Nella mia casella quella parola NON esiste.
    await seedMessage(mineId, { subject: "Tutt'altro argomento" });

    const mine = await search(secret, memberCookie);
    expect(mine.mail.items).toEqual([]);

    // E il verso opposto: il proprietario la trova, quindi il vuoto qui
    // sopra è l'ACL e non una query che non funziona.
    const theirs = await search(secret, adminCookie);
    expect(theirs.mail.items).toHaveLength(1);
    expect(theirs.mail.items[0]!.accountId).toBe(theirsId);
  });

  it("⚠️ nemmeno un ADMIN vede la posta di un member: il ruolo non scavalca", async () => {
    const { accountId } = await seedMailbox(memberId);
    const secret = `Privatoxxx${randomUUID().slice(0, 6)}`;
    await seedMessage(accountId, { subject: `${secret} — solo mio`, textExcerpt: secret });

    // L'admin è admin dell'istanza, ma la casella non è sua.
    const asAdmin = await search(secret, adminCookie);
    expect(asAdmin.mail.items).toEqual([]);

    const asOwner = await search(secret, memberCookie);
    expect(asOwner.mail.items).toHaveLength(1);
  });

  it("senza posta che combacia il gruppo è vuoto, non assente", async () => {
    const body = await search(`Nessunoxxx${randomUUID().slice(0, 6)}`);
    expect(body.mail).toEqual({ items: [], hasMore: false });
  });
});

describe("GET /api/search/docs-semantic", () => {
  it("GLOBALE: recupera Docs semantici da repo di progetti diversi, con repository corretto e score", async () => {
    // Due repo (progetti diversi via seedRepository) con una pagina ciascuno.
    const token = `semglob${randomUUID().slice(0, 8)}`;
    const { repositoryId: repoA } = await seedRepository(testDb.db);
    const genA = await currentGeneration(testDb.db, repoA);
    const slugA = await insertDocPage(testDb.db, repoA, genA, {
      title: `${token} Alfa`,
      body: `Il ${token} di Alfa gestisce l'autenticazione degli utenti.`,
    });
    const { repositoryId: repoB } = await seedRepository(testDb.db);
    const genB = await currentGeneration(testDb.db, repoB);
    const slugB = await insertDocPage(testDb.db, repoB, genB, {
      title: `${token} Beta`,
      body: `Il ${token} di Beta gestisce la fatturazione mensile.`,
    });

    const hits = await docsSemantic(token);
    const hitA = hits.find((h) => h.slug === slugA);
    const hitB = hits.find((h) => h.slug === slugB);
    expect(hitA).toBeDefined();
    expect(hitB).toBeDefined();
    expect(hitA!.repositoryId).toBe(repoA);
    expect(hitB!.repositoryId).toBe(repoB);
    // Shape del gruppo docs + score presente.
    expect(hitA!.snippet.length).toBeGreaterThan(0);
    expect(typeof hitA!.score).toBe("number");
  });

  it("PER-REPO (repositoryId): ristringe a quel repository", async () => {
    const token = `semscope${randomUUID().slice(0, 8)}`;
    const { repositoryId: repoA } = await seedRepository(testDb.db);
    const genA = await currentGeneration(testDb.db, repoA);
    const slugA = await insertDocPage(testDb.db, repoA, genA, {
      title: `${token} A`,
      body: `doc ${token} nel repo A`,
    });
    const { repositoryId: repoB } = await seedRepository(testDb.db);
    const genB = await currentGeneration(testDb.db, repoB);
    const slugB = await insertDocPage(testDb.db, repoB, genB, {
      title: `${token} B`,
      body: `doc ${token} nel repo B`,
    });

    const scoped = await docsSemantic(token, memberCookie, repoA);
    const slugs = scoped.map((h) => h.slug);
    expect(slugs).toContain(slugA);
    expect(slugs).not.toContain(slugB);
  });

  it("embedding non disponibile: lista vuota, nessun 500", async () => {
    // App separata con un embedding client che fallisce sempre: la gamba
    // semantica degrada (full-text-only) e per un token inesistente non c'è
    // nemmeno match full-text → lista vuota, MAI un 500.
    // Stesso DB (le sessioni sono persistite) → il cookie del member esistente è
    // valido anche su questa app; non ri-seediamo gli utenti (setup fallirebbe:
    // admin già presente).
    const brokenApp = buildApp({
      db: testDb.db,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      publicUrl: "https://stubwise.example.com",
      embeddingClient: {
        embed: async () => {
          throw new Error("embedding KO");
        },
      },
    });
    try {
      const res = await brokenApp.inject({
        method: "GET",
        url: `/api/search/docs-semantic?q=inesistente${randomUUID().slice(0, 8)}`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await brokenApp.close();
    }
  });

  it("q assente: 400 (validazione Zod)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/search/docs-semantic",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search/docs-semantic?q=ciao" });
    expect(res.statusCode).toBe(401);
  });
});

async function getHistory(cookie: string, scope?: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/search/history${scope ? `?repositoryId=${scope}` : ""}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    type: string;
    entityId: string;
    title: string;
    subtitle: string | null;
    route: string;
    repositoryId: string | null;
  }[];
}

async function record(
  cookie: string,
  item: {
    type: string;
    entityId: string;
    title: string;
    subtitle?: string | null;
    route: string;
    repositoryId?: string | null;
  },
) {
  return app.inject({ method: "POST", url: "/api/search/history", headers: { cookie }, payload: item });
}

describe("cronologia unificata /api/search/history", () => {
  it("POST registra e GET ritorna i recenti dell'utente", async () => {
    const res = await record(memberCookie, {
      type: "ticket",
      entityId: `t-${randomUUID()}`,
      title: "Un ticket",
      subtitle: "Progetto X",
      route: "/tickets/abc",
    });
    expect(res.statusCode).toBe(204);
    const history = await getHistory(memberCookie);
    expect(history.some((h) => h.title === "Un ticket" && h.type === "ticket")).toBe(true);
  });

  it("upsert: ri-POST della stessa (tipo, entità) non duplica e aggiorna", async () => {
    const entityId = `p-${randomUUID()}`;
    await record(adminCookie, { type: "project", entityId, title: "V1", route: "/projects/x" });
    await record(adminCookie, { type: "project", entityId, title: "V2", route: "/projects/x" });
    const history = await getHistory(adminCookie);
    const matches = history.filter((h) => h.entityId === entityId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.title).toBe("V2");
  });

  it("GET filtra per repositoryId in scope Docs", async () => {
    const { repositoryId } = await seedRepository(testDb.db);
    const otherEntity = `d-${randomUUID()}`;
    // Voce Docs con repositoryId.
    await record(memberCookie, {
      type: "doc",
      entityId: `${repositoryId}:pagina`,
      title: "Pagina",
      subtitle: "technical",
      route: `/docs/${repositoryId}/pagina`,
      repositoryId,
    });
    // Voce senza repository (ticket): non deve comparire nello scope Docs.
    await record(memberCookie, { type: "ticket", entityId: otherEntity, title: "Fuori scope", route: "/tickets/y" });

    const scoped = await getHistory(memberCookie, repositoryId);
    expect(scoped.some((h) => h.entityId === `${repositoryId}:pagina`)).toBe(true);
    expect(scoped.some((h) => h.entityId === otherEntity)).toBe(false);
  });

  it("DELETE per-voce rimuove solo quella; DELETE clear svuota tutto", async () => {
    // Utente dedicato non serve: usiamo un tipo/entità univoci.
    const keep = `k-${randomUUID()}`;
    const drop = `x-${randomUUID()}`;
    await record(memberCookie, { type: "repository", entityId: keep, title: "Keep", route: "/r/keep" });
    await record(memberCookie, { type: "repository", entityId: drop, title: "Drop", route: "/r/drop" });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/search/history/repository/${drop}`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(204);
    let history = await getHistory(memberCookie);
    expect(history.some((h) => h.entityId === drop)).toBe(false);
    expect(history.some((h) => h.entityId === keep)).toBe(true);

    // Clear all.
    const clear = await app.inject({ method: "DELETE", url: "/api/search/history", headers: { cookie: memberCookie } });
    expect(clear.statusCode).toBe(204);
    history = await getHistory(memberCookie);
    expect(history).toHaveLength(0);
  });

  it("poda: oltre 20 voci per utente restano le 20 più recenti", async () => {
    // Utilizza adminId per isolare da altri test che scrivono su memberCookie.
    for (let i = 0; i < 21; i++) {
      const res = await record(adminCookie, {
        type: "ticket",
        entityId: `prune-${i}-${randomUUID()}`,
        title: `P ${i}`,
        route: `/tickets/${i}`,
      });
      expect(res.statusCode).toBe(204);
    }
    const rows = await testDb.db
      .select({ id: searchHistory.id })
      .from(searchHistory)
      .where(eq(searchHistory.userId, adminId));
    expect(rows.length).toBe(20);
  });

  it("senza sessione: 401 su GET e POST", async () => {
    const g = await app.inject({ method: "GET", url: "/api/search/history" });
    expect(g.statusCode).toBe(401);
    const p = await app.inject({
      method: "POST",
      url: "/api/search/history",
      payload: { type: "ticket", entityId: "x", title: "X", route: "/x" },
    });
    expect(p.statusCode).toBe(401);
  });
});
