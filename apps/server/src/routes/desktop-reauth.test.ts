import { randomBytes } from "node:crypto";
import { notifications, personalAccessTokens, securityEvents, users as usersTable } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { resetSecondFactor } from "../auth/second-factor/reset.js";
import { createPatForUser } from "./pat.js";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

// Riconferma dal desktop (decisione del maintainer, 10 nov 2026): il codice
// scritto DENTRO l'app desktop rinfresca la riconferma del SUO PAT per 10
// minuti. Solo un PAT `desktop`: `mobile`, `manual` e i cookie restano fuori.

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let seeded: SeededUsers;
let codes: string[];

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
  });
  seeded = await seedUsers(app);
  codes = await regenerateBackupCodes(testDb.db, ENCRYPTION_KEY, seeded.adminId);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const code = () => codes.shift()!;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const pat = async (kind: "desktop" | "mobile" | "manual", userId = seeded.adminId) =>
  createPatForUser(testDb.db, userId, `T ${kind} ${randomBytes(3).toString("hex")}`, null, kind);

const reauth = (headers: Record<string, string>, value: string) =>
  app.inject({ method: "POST", url: "/api/auth/desktop-reauth", headers, payload: { code: value } });

/** Una rotta sensibile (`config.reauth`) senza altri controlli sul PAT: un'identità git del member. */
let n = 0;
const sensitive = (headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: `/api/users/${seeded.memberId}/git-identities`,
    headers,
    payload: { email: `git-${++n}-${randomBytes(3).toString("hex")}@example.com` },
  });

describe("POST /api/auth/desktop-reauth", () => {
  it("un PAT desktop col codice giusto: 204, la rotta sensibile passa, e il registro ha la riga", async () => {
    const desktop = await pat("desktop");
    const before = await sensitive(bearer(desktop.token));
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ code: "reauth_required" });

    const res = await reauth(bearer(desktop.token), code());
    expect(res.statusCode, res.body).toBe(204);
    expect((await sensitive(bearer(desktop.token))).statusCode).toBe(200);

    const rows = await testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, seeded.adminId), eq(securityEvents.kind, "reauth_desktop")));
    expect(rows).toHaveLength(1);
    // Nessun avviso: la riga del registro basta (D4).
    const alerts = await testDb.db.select().from(notifications).where(eq(notifications.userId, seeded.adminId));
    expect(alerts.filter((a) => (a.event as { kind?: string }).kind === "security.alert")).toEqual([]);
  });

  it("un PAT mobile o manuale: 403, e la rotta sensibile resta session_required", async () => {
    for (const kind of ["mobile", "manual"] as const) {
      const other = await pat(kind);
      const res = await reauth(bearer(other.token), code());
      expect(res.statusCode, kind).toBe(403);
      expect(res.json()).toMatchObject({ code: "desktop_token_required" });
      const blocked = await sensitive(bearer(other.token));
      expect(blocked.statusCode, kind).toBe(403);
      expect(blocked.json()).toMatchObject({ code: "session_required" });
    }
  });

  it("una sessione del browser non usa questa rotta (ha la sua)", async () => {
    const res = await reauth({ cookie: seeded.adminCookie }, code());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "desktop_token_required" });
  });

  it("la finestra è del PAT che ha riconfermato, non degli altri PAT della persona", async () => {
    const a = await pat("desktop");
    const b = await pat("desktop");
    expect((await reauth(bearer(a.token), code())).statusCode).toBe(204);
    expect((await sensitive(bearer(a.token))).statusCode).toBe(200);
    expect((await sensitive(bearer(b.token))).json()).toMatchObject({ code: "reauth_required" });
  });

  it("dopo 10 minuti torna reauth_required", async () => {
    const desktop = await pat("desktop");
    expect((await reauth(bearer(desktop.token), code())).statusCode).toBe(204);
    await testDb.db
      .update(personalAccessTokens)
      .set({ secondFactorAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(personalAccessTokens.id, desktop.id));
    const res = await sensitive(bearer(desktop.token));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "reauth_required" });
  });

  it("un PAT revocato non riconferma e non passa", async () => {
    const desktop = await pat("desktop");
    expect((await reauth(bearer(desktop.token), code())).statusCode).toBe(204);
    await testDb.db.delete(personalAccessTokens).where(eq(personalAccessTokens.id, desktop.id));
    expect((await sensitive(bearer(desktop.token))).statusCode).toBe(401);
    expect((await reauth(bearer(desktop.token), code())).statusCode).toBe(401);
  });

  it("l'azzeramento del 2FA riporta la finestra a null", async () => {
    const [person] = await testDb.db
      .insert(usersTable)
      .values({ email: `reset-${randomBytes(3).toString("hex")}@example.com`, passwordHash: "x", role: "member" })
      .returning({ id: usersTable.id, email: usersTable.email });
    const desktop = await pat("desktop", person!.id);
    await testDb.db
      .update(personalAccessTokens)
      .set({ secondFactorAt: new Date() })
      .where(eq(personalAccessTokens.id, desktop.id));
    await resetSecondFactor(testDb.db, person!, { id: seeded.adminId, email: "admin@example.com" });
    const [row] = await testDb.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, desktop.id));
    expect(row).toBeDefined();
    expect(row!.secondFactorAt).toBeNull();
  });
});

describe("i codici sbagliati: il tetto e il blocco di sempre", () => {
  it("un codice sbagliato è 401 e non apre la finestra; cinque di fila bloccano (423)", async () => {
    const [person] = await testDb.db
      .insert(usersTable)
      .values({ email: `lock-${randomBytes(3).toString("hex")}@example.com`, passwordHash: "x", role: "member" })
      .returning({ id: usersTable.id });
    await regenerateBackupCodes(testDb.db, ENCRYPTION_KEY, person!.id);
    // Un'app confermata, come chi ha finito il login.
    const { fullSessionCookie } = await import("../test/fixtures.js");
    await fullSessionCookie(app, person!.id);
    const desktop = await pat("desktop", person!.id);
    const wrong = await reauth(bearer(desktop.token), "000000");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "invalid_second_factor" });
    const [row] = await testDb.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, desktop.id));
    expect(row!.secondFactorAt).toBeNull();
    let last = wrong;
    for (let i = 0; i < 4; i++) last = await reauth(bearer(desktop.token), "000000");
    expect(last.statusCode).toBe(423);
    expect(last.json()).toMatchObject({ code: "second_factor_locked" });
  });
});
