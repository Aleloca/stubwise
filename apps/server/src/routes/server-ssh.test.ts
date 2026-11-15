import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { decrypt, serverSshAccess, servers } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Area 8, F4b, S7: l'accesso SSH di SOLA LETTURA di un server
 * (`servers.ssh.manage`, istanza). La privata non esce MAI da una risposta;
 * la riga per `authorized_keys` porta `restrict`; l'utente nasce senza gruppi.
 */

const KEY = randomBytes(32);
let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), publicUrl: "https://stubwise.example.com" });
  users = await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function newServer() {
  const [s] = await testDb.db.insert(servers).values({ name: `s-${randomBytes(3).toString("hex")}`, keyHash: `h-${randomBytes(8).toString("hex")}` }).returning();
  return s!.id;
}
const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url: `/api/servers${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

describe("/api/servers/:id/ssh", () => {
  it("senza accesso: none; collegare genera la coppia, risponde con la pubblica, la riga `restrict` e il comando senza gruppi — mai la privata", async () => {
    const id = await newServer();
    expect((await call("GET", `/${id}/ssh`, users.adminCookie)).json()).toMatchObject({ status: "none", canManage: true });
    const res = await call("PUT", `/${id}/ssh`, users.adminCookie, { host: "203.0.113.7", port: 2222 });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({ status: "pending", username: "stubwise-read", host: "203.0.113.7", port: 2222, verifyResult: null });
    expect(view.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ /);
    expect(view.authorizedKeysLine).toBe(`restrict ${view.publicKey}`);
    expect(view.setupCommand).toContain("useradd");
    expect(view.setupCommand).not.toMatch(/-G|usermod|sudo\s+usermod|docker/);
    expect(res.body).not.toContain("PRIVATE KEY");
    const [row] = await testDb.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, id));
    expect(decrypt(row!.privateKeyEncrypted, KEY)).toContain("OPENSSH PRIVATE KEY");
    expect((await call("GET", `/${id}/ssh`, users.adminCookie)).body).not.toContain("PRIVATE KEY");
  });

  it("verificare rimette in attesa; rigenerare cambia la coppia e tiene la host key fissata; revocare la rende inservibile", async () => {
    const id = await newServer();
    const first = (await call("PUT", `/${id}/ssh`, users.adminCookie, { host: "h.example" })).json();
    await testDb.db.update(serverSshAccess).set({ status: "verified", hostKey: "SHA256:pinned", verifyResult: { groups: [], sudo: false, docker: false, journal: false, ok: true } }).where(eq(serverSshAccess.serverId, id));
    expect((await call("POST", `/${id}/ssh/verify`, users.adminCookie)).json()).toMatchObject({ status: "pending", verifyResult: null });
    const again = (await call("POST", `/${id}/ssh/regenerate`, users.adminCookie)).json();
    expect(again.publicKey).not.toBe(first.publicKey);
    const [row] = await testDb.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, id));
    expect(row!.hostKey).toBe("SHA256:pinned");
    const revoked = await call("DELETE", `/${id}/ssh`, users.adminCookie);
    expect(revoked.json()).toMatchObject({ status: "revoked" });
    const [gone] = await testDb.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, id));
    expect(gone!.privateKeyEncrypted).toBe("");
  });

  it("NEGATIVO: senza servers.ssh.manage 403 su tutto, e niente scritto; server inesistente 404", async () => {
    const id = await newServer();
    for (const [m, u] of [["GET", ""], ["PUT", ""], ["POST", "/verify"], ["POST", "/regenerate"], ["DELETE", ""]] as const) {
      expect((await call(m, `/${id}/ssh${u}`, users.memberCookie, m === "PUT" ? { host: "x.example" } : undefined)).statusCode).toBe(403);
    }
    expect(await testDb.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, id))).toEqual([]);
    expect((await call("GET", `/00000000-0000-4000-8000-000000000000/ssh`, users.adminCookie)).statusCode).toBe(404);
  });

  it("richieste del renderer: host facoltativo (l'hostname dell'agente), usable, fingerprint come ssh-keygen, lastUsedAt, revokedAt e il comando di rimozione", async () => {
    const id = await newServer();
    expect((await call("PUT", `/${id}/ssh`, users.adminCookie, {})).json()).toMatchObject({ code: "host_required" });
    await testDb.db.update(servers).set({ hostname: "web1.acme.test" }).where(eq(servers.id, id));
    const view = (await call("PUT", `/${id}/ssh`, users.adminCookie, {})).json();
    expect(view).toMatchObject({ host: "web1.acme.test", port: 22, usable: false, lastUsedAt: null, revokedAt: null, removeCommand: null });
    expect(view.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const used = new Date("2026-11-15T09:00:00Z");
    await testDb.db
      .update(serverSshAccess)
      .set({ status: "verified", hostKey: "SHA256:x", lastUsedAt: used, verifyResult: { groups: [], sudo: false, docker: false, journal: false, ok: true } })
      .where(eq(serverSshAccess.serverId, id));
    expect((await call("GET", `/${id}/ssh`, users.adminCookie)).json()).toMatchObject({ usable: true, lastUsedAt: used.toISOString() });
    // Sospeso dal worker per una host key cambiata: la verifica di prima diceva ok, ma non si usa.
    await testDb.db.update(serverSshAccess).set({ status: "failed" }).where(eq(serverSshAccess.serverId, id));
    expect((await call("GET", `/${id}/ssh`, users.adminCookie)).json()).toMatchObject({ usable: false });
    const revoked = (await call("DELETE", `/${id}/ssh`, users.adminCookie)).json();
    expect(revoked).toMatchObject({ status: "revoked", usable: false, fingerprint: null, removeCommand: "sudo userdel --remove stubwise-read" });
    expect(revoked.revokedAt).not.toBeNull();
  });

  it("un host che non è un host → 400", async () => {
    const id = await newServer();
    for (const host of ["a b", "x;rm -rf /", "-oProxyCommand=sh", ""]) expect((await call("PUT", `/${id}/ssh`, users.adminCookie, { host })).statusCode).toBe(400);
  });
});
