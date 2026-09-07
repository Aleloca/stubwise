import { randomBytes } from "node:crypto";
import { decrypt, googleAccounts, googleWorkspaces } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Registro dei Google Workspace (solo admin). Il punto che questi test
 * presidiano è UNO: il `client_secret` dell'app OAuth non esce mai dall'API e
 * la sua semantica write-only (assente = invariato, `""` = azzera) è
 * osservabile solo dal DB, mai dalla risposta.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";
const PLAINTEXT_SECRET = "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i";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: PUBLIC_URL,
  });
  ({ adminCookie, memberCookie, adminId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db.delete(googleAccounts);
  await testDb.db.delete(googleWorkspaces);
});

const draft = {
  name: "Acme",
  domains: ["Acme.COM", " sub.acme.com "],
  clientId: "123.apps.googleusercontent.com",
  clientSecret: PLAINTEXT_SECRET,
};

function createWorkspace(payload: Record<string, unknown> = draft, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/settings/google-workspaces",
    headers: { cookie },
    payload,
  });
}

async function createdWorkspaceId(payload: Record<string, unknown> = draft): Promise<string> {
  const res = await createWorkspace(payload);
  if (res.statusCode !== 201) throw new Error(`creazione fallita: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Legge il segreto cifrato direttamente dal DB: l'API non lo espone mai. */
async function storedSecret(id: string): Promise<string> {
  const [row] = await testDb.db
    .select()
    .from(googleWorkspaces)
    .where(eq(googleWorkspaces.id, id));
  if (!row) throw new Error("workspace non trovato");
  return row.clientSecretEncrypted;
}

describe("POST /api/settings/google-workspaces", () => {
  it("l'admin crea un Workspace: 201 con la proiezione pubblica, senza segreto", async () => {
    const res = await createWorkspace();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      name: "Acme",
      domains: ["acme.com", "sub.acme.com"],
      clientId: "123.apps.googleusercontent.com",
      clientSecretSet: true,
      accountCount: 0,
      redirectUri: `${PUBLIC_URL}/api/me/google/callback`,
      createdAt: expect.any(String),
    });
    expect(res.body).not.toContain(PLAINTEXT_SECRET);
    expect(res.body).not.toContain("clientSecretEncrypted");
    expect(res.body).not.toContain("client_secret");
  });

  it("il segreto è salvato cifrato (round-trip con la chiave dell'app)", async () => {
    const id = await createdWorkspaceId();
    const encrypted = await storedSecret(id);
    expect(encrypted).not.toContain(PLAINTEXT_SECRET);
    expect(decrypt(encrypted, ENCRYPTION_KEY)).toBe(PLAINTEXT_SECRET);
  });

  it("rifiuta un elenco di domini vuoto", async () => {
    const res = await createWorkspace({ ...draft, domains: [] });
    expect(res.statusCode).toBe(400);
  });

  it("rifiuta un indirizzo email al posto di un dominio", async () => {
    const res = await createWorkspace({ ...draft, domains: ["mario@acme.com"] });
    expect(res.statusCode).toBe(400);
  });

  it("un member non può creare: 403", async () => {
    const res = await createWorkspace(draft, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/google-workspaces",
      payload: draft,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/settings/google-workspaces", () => {
  it("elenca i Workspace con il conteggio delle caselle collegate", async () => {
    const id = await createdWorkspaceId();
    await testDb.db.insert(googleAccounts).values({
      userId: adminId,
      workspaceId: id,
      email: "mario@acme.com",
      googleSub: "sub-1",
      refreshTokenEncrypted: "cifrato",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/google-workspaces",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; accountCount: number; clientSecretSet: boolean }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id, accountCount: 1, clientSecretSet: true });
    expect(res.body).not.toContain(PLAINTEXT_SECRET);
  });

  it("un member non può leggere il registro: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/google-workspaces",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/settings/google-workspaces/:id", () => {
  function patch(id: string, payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({
      method: "PATCH",
      url: `/api/settings/google-workspaces/${id}`,
      headers: { cookie },
      payload,
    });
  }

  it("una patch SENZA clientSecret non tocca il segreto salvato", async () => {
    const id = await createdWorkspaceId();
    const before = await storedSecret(id);

    const res = await patch(id, { name: "Acme Inc." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Acme Inc.", clientSecretSet: true });
    expect(await storedSecret(id)).toBe(before);
  });

  it("una patch con clientSecret vuoto AZZERA il segreto", async () => {
    const id = await createdWorkspaceId();

    const res = await patch(id, { clientSecret: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clientSecretSet: false });
    expect(await storedSecret(id)).toBe("");
  });

  it("una patch con un clientSecret nuovo lo ricifra", async () => {
    const id = await createdWorkspaceId();
    const before = await storedSecret(id);

    const res = await patch(id, { clientSecret: "GOCSPX-nuovo" });
    expect(res.statusCode).toBe(200);
    const after = await storedSecret(id);
    expect(after).not.toBe(before);
    expect(decrypt(after, ENCRYPTION_KEY)).toBe("GOCSPX-nuovo");
    expect(res.body).not.toContain("GOCSPX-nuovo");
  });

  it("normalizza i domini anche in modifica", async () => {
    const id = await createdWorkspaceId();
    const res = await patch(id, { domains: ["ALTRO.example", "altro.example"] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { domains: string[] }).domains).toEqual(["altro.example"]);
  });

  it("una patch vuota è una lettura: 200 senza cambiare nulla", async () => {
    const id = await createdWorkspaceId();
    const before = await storedSecret(id);
    const res = await patch(id, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Acme", clientSecretSet: true });
    expect(await storedSecret(id)).toBe(before);
  });

  it("id inesistente: 404", async () => {
    const res = await patch("11111111-1111-4111-8111-111111111111", { name: "X" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("google_workspace_not_found");
  });

  it("un member non può modificare: 403", async () => {
    const id = await createdWorkspaceId();
    const res = await patch(id, { name: "X" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/settings/google-workspaces/:id", () => {
  it("elimina un Workspace senza caselle: 204", async () => {
    const id = await createdWorkspaceId();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/settings/google-workspaces/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await testDb.db.select().from(googleWorkspaces)).toHaveLength(0);
  });

  it("con caselle collegate: 409 workspace_in_use e la riga resta", async () => {
    const id = await createdWorkspaceId();
    await testDb.db.insert(googleAccounts).values({
      userId: adminId,
      workspaceId: id,
      email: "mario@acme.com",
      googleSub: "sub-1",
      refreshTokenEncrypted: "cifrato",
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/settings/google-workspaces/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("workspace_in_use");
    expect(await testDb.db.select().from(googleWorkspaces)).toHaveLength(1);
  });

  it("id inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/settings/google-workspaces/11111111-1111-4111-8111-111111111111",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const id = await createdWorkspaceId();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/settings/google-workspaces/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
