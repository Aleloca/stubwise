import { randomBytes } from "node:crypto";
import { notifications, personalAccessTokens, securityEvents, users as usersTable } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
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
    // La riconferma (senza azione) e l'azione fatta con la finestra.
    expect(rows.map((r) => r.detail).sort()).toEqual(["POST /api/users/:id/git-identities", null]);
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

// Le rotte che rifiutavano un PAT nel loro handler (decisione del maintainer,
// 10 nov 2026: «dal desktop si deve poter fare tutto quello che si fa dal
// browser»): il PAT desktop passa SOLO con la finestra di riconferma; mobile e
// manual mai, nemmeno con `second_factor_at` scritto a mano; scaduta = no.
describe("le rotte aperte al PAT desktop riconfermato (la regola unica)", () => {
  type Kind = "desktop" | "mobile" | "manual";
  /** Un PAT di `kind` per `userId`, con la finestra aperta (`"open"`), scaduta (`"expired"`) o mai aperta. */
  async function patWith(kind: Kind, window: "open" | "expired" | "none", userId = seeded.adminId) {
    const p = await pat(kind, userId);
    if (window !== "none") {
      await testDb.db
        .update(personalAccessTokens)
        .set({ secondFactorAt: new Date(Date.now() - (window === "open" ? 1000 : 11 * 60 * 1000)) })
        .where(eq(personalAccessTokens.id, p.id));
    }
    return p;
  }

  const challenge = "a".repeat(43);
  const ROUTES: { name: string; call: (headers: Record<string, string>) => Promise<Awaited<ReturnType<typeof app.inject>>>; ok: number }[] = [
    {
      name: "POST /api/pats",
      call: async (headers) => app.inject({ method: "POST", url: "/api/pats", headers, payload: { name: `dal desktop ${++n}` } }),
      ok: 201,
    },
    {
      name: "POST /api/auth/desktop-handoff",
      call: async (headers) =>
        app.inject({ method: "POST", url: "/api/auth/desktop-handoff", headers, payload: { codeChallenge: challenge, deviceName: "Altro Mac" } }),
      ok: 200,
    },
    {
      name: "POST /api/users/:id/password-reset",
      call: async (headers) => app.inject({ method: "POST", url: `/api/users/${seeded.memberId}/password-reset`, headers }),
      ok: 201,
    },
  ];

  for (const route of ROUTES) {
    it(`${route.name}: senza finestra reauth_required, con la finestra ok, scaduta no, mobile e manual mai`, async () => {
      const none = await route.call(bearer((await patWith("desktop", "none")).token));
      expect(none.statusCode, none.body).toBe(403);
      expect(none.json()).toMatchObject({ code: "reauth_required" });

      const open = await route.call(bearer((await patWith("desktop", "open")).token));
      expect(open.statusCode, open.body).toBe(route.ok);

      const expired = await route.call(bearer((await patWith("desktop", "expired")).token));
      expect(expired.statusCode).toBe(403);
      expect(expired.json()).toMatchObject({ code: "reauth_required" });

      for (const kind of ["mobile", "manual"] as const) {
        const other = await route.call(bearer((await patWith(kind, "open")).token));
        expect(other.statusCode, `${route.name} ${kind}`).toBe(403);
        expect(other.json()).toMatchObject({ code: "session_required" });
      }
    });
  }

  it("ogni azione fatta con la finestra lascia una riga reauth_desktop con l'azione, una sola", async () => {
    const p = await patWith("desktop", "open");
    const before = await testDb.db.select().from(securityEvents).where(eq(securityEvents.kind, "reauth_desktop"));
    expect((await ROUTES[0]!.call(bearer(p.token))).statusCode).toBe(201);
    expect((await ROUTES[1]!.call(bearer(p.token))).statusCode).toBe(200);
    const after = await testDb.db.select().from(securityEvents).where(eq(securityEvents.kind, "reauth_desktop"));
    const added = after.filter((r) => !before.some((b) => b.id === r.id)).map((r) => r.detail).sort();
    expect(added).toEqual(["POST /api/auth/desktop-handoff", "POST /api/pats"]);
  });

  it("POST /api/auth/me/password: dal desktop riconfermato; il token resta ma perde la finestra, gli altri delle app cadono", async () => {
    const [person] = await testDb.db
      .insert(usersTable)
      .values({ email: `pw-${randomBytes(3).toString("hex")}@example.com`, passwordHash: await hashPassword("vecchia-password-1"), role: "member" })
      .returning({ id: usersTable.id });
    const { fullSessionCookie } = await import("../test/fixtures.js");
    await fullSessionCookie(app, person!.id);
    const change = (token: string, currentPassword: string, newPassword: string) =>
      app.inject({ method: "POST", url: "/api/auth/me/password", headers: bearer(token), payload: { currentPassword, newPassword } });

    const none = await change((await patWith("desktop", "none", person!.id)).token, "vecchia-password-1", "nuova-password-22");
    expect(none.json()).toMatchObject({ code: "reauth_required" });
    const expired = await change((await patWith("desktop", "expired", person!.id)).token, "vecchia-password-1", "nuova-password-22");
    expect(expired.json()).toMatchObject({ code: "reauth_required" });
    for (const kind of ["mobile", "manual"] as const) {
      const r = await change((await patWith(kind, "open", person!.id)).token, "vecchia-password-1", "nuova-password-22");
      expect(r.statusCode, kind).toBe(403);
      expect(r.json()).toMatchObject({ code: "session_required" });
    }

    const current = await patWith("desktop", "open", person!.id);
    const sibling = await patWith("desktop", "open", person!.id);
    const ok = await change(current.token, "vecchia-password-1", "nuova-password-22");
    expect(ok.statusCode, ok.body).toBe(204);
    const rows = await testDb.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, person!.id));
    const kept = rows.find((r) => r.id === current.id);
    expect(kept).toBeDefined();
    expect(kept!.secondFactorAt).toBeNull();
    expect(rows.find((r) => r.id === sibling.id)).toBeUndefined();
    expect(rows.filter((r) => r.kind === "mobile")).toEqual([]);
    expect(rows.some((r) => r.kind === "manual")).toBe(true);
  });
});

describe("la cassaforte resta solo-browser (aperta per decisione, bloccata dallo sblocco PRF)", () => {
  it("il PAT desktop riconfermato riceve session_required su ogni tipo di rotta della cassaforte", async () => {
    const p = await pat("desktop");
    await testDb.db
      .update(personalAccessTokens)
      .set({ secondFactorAt: new Date() })
      .where(eq(personalAccessTokens.id, p.id));
    for (const url of ["/api/vault/status", "/api/vault/pending", "/api/vault/keys/mine"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(p.token) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: "session_required" });
    }
  });

  it("ogni rotta /api/vault dichiara browserOnly (anche quelle col solo gate della riconferma)", async () => {
    // L'osservatore gira PRIMA dell'hook della cassaforte: si tiene l'oggetto
    // della rotta e lo si legge a registrazione finita.
    const seen: { url: string; config?: { browserOnly?: unknown } }[] = [];
    const probe = buildApp({
      onRoute: (route) => {
        // `/api/vault/credentials` è di `credentials.ts`: il PAT «crea e
        // sostituisce» di vault.md, con le sue regole (che non cambiano).
        if (route.url.startsWith("/api/vault") && route.url !== "/api/vault/credentials") seen.push(route as never);
      },
    } as Parameters<typeof buildApp>[0]);
    await probe.ready();
    await probe.close();
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.filter((r) => r.config?.browserOnly !== true).map((r) => r.url)).toEqual([]);
  });

  it("una rotta della cassaforte col SOLO gate della riconferma resta chiusa al desktop riconfermato", async () => {
    const p = await pat("desktop");
    await testDb.db
      .update(personalAccessTokens)
      .set({ secondFactorAt: new Date() })
      .where(eq(personalAccessTokens.id, p.id));
    const res = await app.inject({ method: "POST", url: "/api/vault/recovery/challenge", headers: bearer(p.token) });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
  });

  it("la regola: browserOnly chiude anche il desktop riconfermato; la sessione passa", async () => {
    const { browserOrConfirmedDesktop } = await import("../auth/access.js");
    const desktop = { id: "u", patId: "p", patKind: "desktop", patSecondFactorAt: new Date() } as never;
    expect(browserOrConfirmedDesktop(desktop)).toEqual({ ok: true, via: "desktop" });
    expect(browserOrConfirmedDesktop(desktop, { browserOnly: true })).toEqual({ ok: false, code: "session_required" });
    expect(browserOrConfirmedDesktop({ id: "u", sessionId: "s" } as never, { browserOnly: true })).toEqual({ ok: true, via: "session" });
    // Le rotte aperte hanno anche il gate `config.reauth`, che ferma prima:
    // la regola si prova anche da sola (è la difesa degli handler).
    const old = new Date(Date.now() - 11 * 60 * 1000);
    expect(browserOrConfirmedDesktop({ id: "u", patId: "p", patKind: "desktop", patSecondFactorAt: old } as never)).toEqual({
      ok: false,
      code: "reauth_required",
    });
    expect(browserOrConfirmedDesktop({ id: "u", patId: "p", patKind: "desktop", patSecondFactorAt: null } as never)).toEqual({
      ok: false,
      code: "reauth_required",
    });
    for (const kind of ["mobile", "manual"] as const) {
      expect(browserOrConfirmedDesktop({ id: "u", patId: "p", patKind: kind, patSecondFactorAt: new Date() } as never), kind).toEqual({
        ok: false,
        code: "session_required",
      });
    }
    // Il token del turno della chat: niente PAT, niente sessione.
    expect(browserOrConfirmedDesktop({ id: "u", chatToolSessionId: "c" } as never)).toEqual({ ok: false, code: "session_required" });
  });
});

describe("reauth_desktop si registra solo quando la richiesta passa davvero", () => {
  it("il desktop riconfermato di chi non ha il permesso: 403, e nessuna riga con l'azione", async () => {
    const p = await pat("desktop", seeded.memberId);
    await testDb.db
      .update(personalAccessTokens)
      .set({ secondFactorAt: new Date() })
      .where(eq(personalAccessTokens.id, p.id));
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${seeded.adminId}/git-identities`,
      headers: bearer(p.token),
      payload: { email: `no-${randomBytes(3).toString("hex")}@example.com` },
    });
    expect(res.statusCode).toBe(403);
    const rows = await testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, seeded.memberId), eq(securityEvents.kind, "reauth_desktop")));
    expect(rows).toEqual([]);
  });
});
