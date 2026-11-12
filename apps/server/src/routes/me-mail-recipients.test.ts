import { randomUUID } from "node:crypto";
import { emailMessages, googleAccounts, googleWorkspaces, projects, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * I DESTINATARI SUGGERITI (area 6, F3, task 5): prima il team che chi scrive
 * vede, poi gli indirizzi delle SUE caselle. Nessuna chiamata a Google.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 5).toString("base64") });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

type Item = { name: string | null; email: string; personId: string | null; group: "team" | "mail" };
const suggest = async (headers: { cookie: string }, q: string) => {
  const res = await app.inject({ method: "GET", url: `/api/me/mail/recipients?q=${encodeURIComponent(q)}`, headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: Item[] }).items;
};

async function seed() {
  const tag = randomUUID().slice(0, 6);
  const [project] = await db.insert(projects).values({ name: "Audin", slug: `audin-${tag}`, ingestionKey: randomUUID() }).returning();
  const me = await createUserWithSession(app, `ada-${tag}@acme.com`);
  const mate = await createUserWithSession(app, `marta-${tag}@acme.com`);
  const stranger = await createUserWithSession(app, `marco-${tag}@acme.com`); // nessun progetto in comune (lo si vede comunque: `users.view_all` è di tutti)
  const other = await createUserWithSession(app, `otto-${tag}@acme.com`);
  await db.update(users).set({ displayName: "Marta Rossi" }).where(eq(users.id, mate.id));
  await addMember(app, project!.id, me.id, "developer");
  await addMember(app, project!.id, mate.id, "developer");
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const myBox = `ada-box-${tag}@acme.com`;
  const [box] = await db.insert(googleAccounts).values({ userId: me.id, workspaceId: ws!.id, email: myBox, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [otherBox] = await db.insert(googleAccounts).values({ userId: other.id, workspaceId: ws!.id, email: `otto-box-${tag}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const msg = (accountId: string, n: number, fromAddress: string, fromName: string | null, to: string[], cc: string[] | null = null) => ({
    accountId,
    gmailMessageId: `g-${tag}-${n}`,
    threadId: `t-${n}`,
    fromAddress,
    fromName,
    toAddresses: to,
    ccAddresses: cc,
    subject: "x",
    receivedAt: new Date(Date.now() - n * 60_000),
  });
  await db.insert(emailMessages).values([
    // Mario due volte ma PIÙ VECCHIO: passa davanti per frequenza, non per data.
    msg(box!.id, 5, `mario.cliente-${tag}@x.it`, "Mario Cliente", [myBox]),
    msg(box!.id, 6, `mario.cliente-${tag}@x.it`, "Mario Cliente", [myBox]),
    msg(box!.id, 3, `martina-${tag}@fornitore.it`, "Martina", [myBox], [`mariella-${tag}@cc.it`]),
    // Nella casella di un ALTRO: non deve mai uscire a me.
    msg(otherBox!.id, 4, `mar-segreto-${tag}@riservato.it`, "Segreto", [`otto-box-${tag}@acme.com`, `mar-to-segreto-${tag}@riservato.it`], [`mar-cc-segreto-${tag}@riservato.it`]),
  ]);
  return { tag, me, mate, stranger, myBox };
}

describe("GET /api/me/mail/recipients", () => {
  it("prima il team che vedo (con personId), poi gli indirizzi delle MIE caselle, il più frequente prima", async () => {
    const { tag, me, mate, stranger } = await seed();
    const items = await suggest(me.headers, `-${tag}`);
    const team = items.filter((i) => i.group === "team" && i.email.includes(tag));
    expect(team).toEqual([
      { name: null, email: `marco-${tag}@acme.com`, personId: stranger.id, group: "team" },
      { name: "Marta Rossi", email: `marta-${tag}@acme.com`, personId: mate.id, group: "team" },
      { name: null, email: `otto-${tag}@acme.com`, personId: expect.any(String), group: "team" },
    ]);
    // Mai sé stessi.
    expect(team.map((t) => t.personId)).not.toContain(me.id);
    expect(items.findIndex((i) => i.group === "mail")).toBeGreaterThan(items.findIndex((i) => i.group === "team"));
    const mail = (await suggest(me.headers, "mar")).filter((i) => i.group === "mail" && i.email.includes(tag)).map((i) => i.email);
    // Mario due volte, poi a pari frequenza e data in ordine alfabetico.
    expect(mail).toEqual([`mario.cliente-${tag}@x.it`, `mariella-${tag}@cc.it`, `martina-${tag}@fornitore.it`]);
    expect(items.find((i) => i.email === `mario.cliente-${tag}@x.it`)).toMatchObject({ name: "Mario Cliente", personId: null });
  });

  it("il team è quello di GET /api/users, né più né meno (la stessa regola di visibilità)", async () => {
    const { tag, me } = await seed();
    const listed = ((await app.inject({ method: "GET", url: "/api/users", headers: me.headers })).json() as { id: string; email: string }[])
      .filter((u) => u.email.includes(tag) && u.id !== me.id)
      .map((u) => u.id)
      .sort();
    const team = (await suggest(me.headers, tag)).filter((i) => i.group === "team").map((i) => i.personId).sort();
    expect(team).toEqual(listed);
  });

  it("NEGATIVO: gli indirizzi della casella di un ALTRO non escono mai, né le mie caselle", async () => {
    const { tag, me, myBox } = await seed();
    const emails = (await suggest(me.headers, "mar")).map((i) => i.email);
    expect(emails).not.toContain(`mar-segreto-${tag}@riservato.it`);
    expect(emails).not.toContain(`mar-to-segreto-${tag}@riservato.it`);
    expect(emails).not.toContain(`mar-cc-segreto-${tag}@riservato.it`);
    expect((await suggest(me.headers, "ada-box")).map((i) => i.email)).not.toContain(myBox);
  });

  it("una persona del team che compare anche nella posta esce UNA volta, come team; il nome cerca anche", async () => {
    const { tag, me, mate } = await seed();
    const [box] = await db.select().from(googleAccounts).where(eq(googleAccounts.userId, me.id));
    await db.insert(emailMessages).values({ accountId: box!.id, gmailMessageId: `g-${tag}-9`, threadId: "t9", fromAddress: `MARTA-${tag}@acme.com`, fromName: "Marta", toAddresses: [box!.email], subject: "x", receivedAt: new Date() });
    const items = await suggest(me.headers, `marta-${tag}`);
    expect(items).toEqual([expect.objectContaining({ personId: mate.id, group: "team" })]);
    expect((await suggest(me.headers, "Rossi")).map((i) => i.personId)).toContain(mate.id);
  });

  it("l'utente di sistema «Claude» non è un destinatario", async () => {
    const { me } = await seed();
    const [agent] = await db.select().from(users).where(eq(users.isAgent, true));
    expect(agent).toBeDefined();
    expect((await suggest(me.headers, agent!.email)).map((i) => i.personId)).not.toContain(agent!.id);
  });

  it("i caratteri jolly si cercano letterali, e una q vuota non dà niente", async () => {
    const { me } = await seed();
    expect(await suggest(me.headers, "%")).toEqual([]);
    expect(await suggest(me.headers, "_")).toEqual([]);
    const res = await app.inject({ method: "GET", url: "/api/me/mail/recipients?q=", headers: me.headers });
    expect((res.json() as { items: unknown[] }).items ?? []).toEqual([]);
  });
});
