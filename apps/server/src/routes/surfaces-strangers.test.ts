import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decisionRequests, driveFiles, projects, releases, users, widgetConversations, widgetMessages } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Registro, A11 r.1414 (revisione del lotto 2, I2): le superfici del server
 * che il prototipo già copre. Chi guarda non riceve l'id di uno sconosciuto
 * VERO (nessun progetto in comune, presente o passato, nessun canale), messo
 * a mano nel DB. Campo per campo: il segnaposto dove stava l'id.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const stranger = async () =>
  (await t.db.insert(users).values({ email: `stranger-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Zeta" }).returning({ id: users.id }))[0]!.id;

describe("le superfici senza gli sconosciuti", () => {
  it("le decisioni: chi ha chiesto, sconosciuto, è `hidden-1`; la persona a cui si chiede (chi guarda) resta vera", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-dc-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const zed = await stranger();
    await t.db.insert(decisionRequests).values({ ticketId, askedByUserId: zed, askedOfUserId: reader.id, question: "Sì?", options: [] } as never);
    const res = await app.inject({ method: "GET", url: `/api/decisions?askedOfId=me`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const [item] = res.json() as { askedById: string; askedOfId: string }[];
    expect(item).toMatchObject({ askedById: "hidden-1", askedOfId: reader.id });
    expect(res.body).not.toContain(zed);
  });

  it("il Drive: chi ha aggiunto il file, sconosciuto, è `hidden-1` nell'elenco e nel dettaglio", async () => {
    const { projectId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-dr-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const zed = await stranger();
    const [file] = await t.db
      .insert(driveFiles)
      .values({ projectId, number: 1, name: "contratto.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `drive/${projectId}/x/contratto.pdf`, addedBy: zed })
      .returning({ id: driveFiles.id });
    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/drive/files`, headers: { cookie: reader.headers.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { items: { id: string; addedById: string }[] }).items.find((f) => f.id === file!.id)!.addedById).toBe("hidden-1");
    expect(list.body).not.toContain(zed);
    const detail = await app.inject({ method: "GET", url: `/api/drive/files/${file!.id}`, headers: { cookie: reader.headers.cookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain(zed);
    expect(detail.body).toContain('"addedById":"hidden-1"');
  });

  it("i rilasci: chi ha fatto il merge, sconosciuto, è `hidden-1` nell'elenco e nel dettaglio", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const code = `S${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await t.db.update(projects).set({ code }).where(eq(projects.id, projectId));
    const reader = await createUserWithSession(app, `reader-rl-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const zed = await stranger();
    await t.db
      .insert(releases)
      .values({ code: `${code}-V1`, seq: 1, projectId, repositoryId, prNumber: 4, prUrl: "https://x/pr/4", title: "Checkout", mergeSha: "d".repeat(40), mergedAt: new Date(), mergedBy: zed, viaStubwise: true });
    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/releases`, headers: { cookie: reader.headers.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { items: { mergedById: string | null }[] }).items[0]!.mergedById).toBe("hidden-1");
    expect(list.body).not.toContain(zed);
    const detail = await app.inject({ method: "GET", url: `/api/releases/${code}-V1`, headers: { cookie: reader.headers.cookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { mergedById: string | null }).mergedById).toBe("hidden-1");
    expect(detail.body).not.toContain(zed);
  });

  it("il supporto: chi del team ha scritto, sconosciuto, è `hidden-1` nel dettaglio della conversazione", async () => {
    const { projectId } = await seedRepository(t.db);
    const code = `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await t.db.update(projects).set({ code }).where(eq(projects.id, projectId));
    const reader = await createUserWithSession(app, `reader-sp-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const zed = await stranger();
    const [c] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: randomUUID(), externalUserName: "Mario", externalUserEmail: "m@x.it" }).returning();
    await t.db.insert(widgetMessages).values({ conversationId: c!.id, role: "team", content: "Ci pensiamo noi", authorId: zed, createdAt: new Date() } as never);
    const res = await app.inject({ method: "GET", url: `/api/support/conversations/by-code/${code}-S${c!.number}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(zed);
    expect(res.body).toContain('"authorId":"hidden-1"');
  });
});
