import { randomUUID } from "node:crypto";
import { changeLog, roles, userTotp, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { MailMessage, MailTransport } from "../mail/transport.js";
import { addMember, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F2, Task 4: gli scrittori del registro sulle persone. Ogni percorso
 * lascia la sua voce, nella transazione della modifica: uno che fallisce dopo
 * non la lascia.
 */

const sent: MailMessage[] = [];
const transport: MailTransport = { isConfigured: () => true, async send(m) { sent.push(m); } };

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64"), publicUrl: "https://s.example.com", mailTransport: transport });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person() {
  const email = `cl-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, email };
}
const entries = (subjectId: string, type?: string) =>
  db.select().from(changeLog).where(and(eq(changeLog.subjectId, subjectId), ...(type ? [eq(changeLog.type, type)] : []))).orderBy(desc(changeLog.at));
const as = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("il registro: le persone", () => {
  it("il ruolo d'istanza: prima e dopo coi nomi di allora", async () => {
    const p = await person();
    const [r] = await db.insert(roles).values({ name: `Ufficio ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["users.view_all"] }).returning({ id: roles.id, name: roles.name });
    expect((await as("PATCH", `/api/users/${p.id}/instance-role`, { roleId: r!.id })).statusCode).toBe(200);
    const [e] = await entries(p.id, "person.instance_role_changed");
    expect(e).toMatchObject({ actorUserId: adminId, projectId: null, subjectKind: "person" });
    expect(e!.data).toMatchObject({ object: { type: "person", id: p.id, label: p.email }, before: "User", after: r!.name });
  });

  it("un rifiuto che arriva DOPO la voce (il proprio ruolo: 400 dopo l'UPDATE) non la lascia", async () => {
    const [r] = await db.insert(roles).values({ name: `Mio ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["instance.full_admin"] }).returning({ id: roles.id });
    expect((await as("PATCH", `/api/users/${adminId}/instance-role`, { roleId: r!.id })).statusCode).toBe(400);
    expect(await entries(adminId, "person.instance_role_changed")).toHaveLength(0);
  });

  it("link di reset, azzeramento del secondo fattore: una voce ciascuno, e nessun token nella voce", async () => {
    const p = await person();
    const reset = await as("POST", `/api/users/${p.id}/password-reset`);
    expect(reset.statusCode).toBe(201);
    const token = (reset.json() as { token: string }).token;
    const [link] = await entries(p.id, "person.password_reset_link_created");
    expect(JSON.stringify(link!.data)).not.toContain(token);
    await db.insert(userTotp).values({ userId: p.id, secretEncrypted: "x", confirmedAt: new Date() });
    expect((await as("DELETE", `/api/users/${p.id}/second-factor`)).statusCode).toBe(204);
    expect(await entries(p.id, "person.second_factor_reset")).toHaveLength(1);
  });

  it("disattivare e riattivare; un fallimento DOPO la modifica non lascia la voce", async () => {
    const p = await person();
    expect((await as("POST", `/api/users/${p.id}/deactivate`, {})).statusCode).toBe(204);
    expect((await as("POST", `/api/users/${p.id}/reactivate`)).statusCode).toBe(204);
    expect((await entries(p.id)).map((e) => e.type).sort()).toEqual(["person.deactivated", "person.reactivated"]);
    // L'ultimo gestore attivo di un progetto: la disattivazione si annulla (409), e nessuna voce.
    const { projectId } = await seedRepository(db);
    const lead = await person();
    await addMember(app, projectId, lead.id, "project_lead");
    expect((await as("POST", `/api/users/${lead.id}/deactivate`, {})).statusCode).toBe(409);
    expect(await entries(lead.id, "person.deactivated")).toHaveLength(0);
  });

  it("il cambio dell'email, confermato dal link e fatto da un admin: prima e dopo", async () => {
    const p = await person();
    const target = `new-${randomUUID().slice(0, 6)}@acme.com`;
    expect((await as("PATCH", `/api/users/${p.id}/email`, { email: target })).statusCode).toBe(200);
    const [byAdmin] = await entries(p.id, "person.email_changed");
    expect(byAdmin).toMatchObject({ actorUserId: adminId });
    expect(byAdmin!.data).toMatchObject({ before: p.email, after: target });
  });

  it("le identità git e Bitbucket", async () => {
    const p = await person();
    const email = `git-${randomUUID().slice(0, 6)}@acme.com`;
    expect((await as("POST", `/api/users/${p.id}/git-identities`, { email })).statusCode).toBe(200);
    expect((await as("DELETE", `/api/users/${p.id}/git-identities/${encodeURIComponent(email)}`)).statusCode).toBe(204);
    const bb = `bb-${randomUUID().slice(0, 6)}`;
    expect((await as("PUT", `/api/users/${p.id}/bitbucket`, { username: bb })).statusCode).toBe(200);
    const types = (await entries(p.id)).map((e) => e.type).sort();
    expect(types).toEqual(["person.bitbucket_username_set", "person.git_identity_linked", "person.git_identity_unlinked"]);
    const [linked] = await entries(p.id, "person.git_identity_linked");
    expect(linked!.data).toMatchObject({ params: { email } });
    const [set] = await entries(p.id, "person.bitbucket_username_set");
    expect(set!.data).toMatchObject({ before: null, after: bb });
  });
});
