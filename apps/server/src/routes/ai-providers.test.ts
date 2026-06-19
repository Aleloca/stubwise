import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiProviders, decrypt } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PLAINTEXT_SECRET = "sk-segreto-da-non-salvare-in-chiaro";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createProvider(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/ai-providers",
    headers: { cookie },
    payload,
  });
}

const basePayload = {
  kind: "api_key",
  label: "Anthropic API",
  secret: PLAINTEXT_SECRET,
};

describe("POST /api/ai-providers", () => {
  it("l'admin crea un provider: 201 con la proiezione pubblica, senza secret", async () => {
    const res = await createProvider(basePayload);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      kind: "api_key",
      label: "Anthropic API",
      position: expect.any(Number),
      enabled: true,
      secretSet: true,
      createdAt: expect.any(String),
    });
    expect(res.body).not.toContain("secret_encrypted");
    expect(res.body).not.toContain("secretEncrypted");
    expect(res.body).not.toContain(PLAINTEXT_SECRET);
  });

  it("la secret è salvata cifrata (round-trip con la chiave dell'app)", async () => {
    const res = await createProvider({ kind: "account", label: "Claude Max", secret: PLAINTEXT_SECRET });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.secretEncrypted).not.toContain(PLAINTEXT_SECRET);
    expect(decrypt(row!.secretEncrypted, ENCRYPTION_KEY)).toBe(PLAINTEXT_SECRET);
  });

  it("position assente: append in coda (crescente)", async () => {
    const a = await createProvider({ ...basePayload, label: "Coda A" });
    const b = await createProvider({ ...basePayload, label: "Coda B" });
    const posA = (a.json() as { position: number }).position;
    const posB = (b.json() as { position: number }).position;
    expect(posB).toBeGreaterThan(posA);
  });

  it("position esplicita: rispettata", async () => {
    const res = await createProvider({ ...basePayload, label: "Posizionato", position: 99 });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { position: number }).position).toBe(99);
  });

  it("un member non può creare: 403", async () => {
    const res = await createProvider({ ...basePayload, label: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/ai-providers", payload: basePayload });
    expect(res.statusCode).toBe(401);
  });

  it("kind sconosciuto: 400", async () => {
    const res = await createProvider({ ...basePayload, kind: "oauth" });
    expect(res.statusCode).toBe(400);
  });

  it("secret vuota: 400", async () => {
    const res = await createProvider({ ...basePayload, secret: "" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/ai-providers", () => {
  it("l'admin legge la lista ordinata per position, senza secret", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ai-providers",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { position: number; secretSet: boolean }[];
    expect(body.length).toBeGreaterThanOrEqual(2);
    const positions = body.map((p) => p.position);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(body.every((p) => p.secretSet === true)).toBe(true);
    expect(res.body).not.toContain(PLAINTEXT_SECRET);
    expect(res.body).not.toContain("secretEncrypted");
  });

  it("un member non può leggere: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ai-providers",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ai-providers" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/ai-providers/:id", () => {
  it("aggiorna label/enabled/position senza toccare la secret", async () => {
    const created = await createProvider({ ...basePayload, label: "Da Modificare" });
    const id = (created.json() as { id: string }).id;
    const [before] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));

    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
      payload: { label: "Modificato", enabled: false, position: 42 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { label: string; enabled: boolean; position: number; secretSet: boolean };
    expect(body.label).toBe("Modificato");
    expect(body.enabled).toBe(false);
    expect(body.position).toBe(42);
    expect(body.secretSet).toBe(true);

    const [after] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(after!.secretEncrypted).toBe(before!.secretEncrypted);
  });

  it("secret presente: re-encrypt (blob cambia, round-trip nuovo valore)", async () => {
    const created = await createProvider({ ...basePayload, label: "Ruota Secret" });
    const id = (created.json() as { id: string }).id;
    const [before] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));

    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
      payload: { secret: "nuovo-secret-ruotato" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("nuovo-secret-ruotato");

    const [after] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(after!.secretEncrypted).not.toBe(before!.secretEncrypted);
    expect(decrypt(after!.secretEncrypted, ENCRYPTION_KEY)).toBe("nuovo-secret-ruotato");
  });

  it("secret assente: invariata", async () => {
    const created = await createProvider({ ...basePayload, label: "Secret Invariata" });
    const id = (created.json() as { id: string }).id;
    const [before] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
      payload: { label: "Solo Label" },
    });
    expect(res.statusCode).toBe(200);
    const [after] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(after!.secretEncrypted).toBe(before!.secretEncrypted);
  });

  it("secret vuota: 400 (non si può svuotare)", async () => {
    const created = await createProvider({ ...basePayload, label: "No Svuota" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
      payload: { secret: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH vuoto: provider invariato (200)", async () => {
    const created = await createProvider({ ...basePayload, label: "Invariato" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { label: string }).label).toBe("Invariato");
  });

  it("inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/ai-providers/00000000-0000-0000-0000-000000000000",
      headers: { cookie: adminCookie },
      payload: { label: "Nessuno" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può modificare: 403", async () => {
    const created = await createProvider({ ...basePayload, label: "Protetto" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: memberCookie },
      payload: { label: "Hackerato" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/ai-providers/:id", () => {
  it("elimina (204) e 404 al secondo tentativo", async () => {
    const created = await createProvider({ ...basePayload, label: "Da Eliminare" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const created = await createProvider({ ...basePayload, label: "Protetto Delete" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/ai-providers/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/ai-providers/reorder", () => {
  it("riscrive le position nell'ordine dato (0..n-1)", async () => {
    // Il riordino richiede l'insieme COMPLETO dei provider (drag&drop manda
    // sempre la lista intera): leggiamo lo stato corrente e invertiamo l'ordine.
    const list = await app.inject({
      method: "GET",
      url: "/api/ai-providers",
      headers: { cookie: adminCookie },
    });
    const current = (list.json() as { id: string }[]).map((p) => p.id);
    expect(current.length).toBeGreaterThanOrEqual(3);
    const reversed = [...current].reverse();

    const res = await app.inject({
      method: "POST",
      url: "/api/ai-providers/reorder",
      headers: { cookie: adminCookie },
      payload: { orderedIds: reversed },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; position: number }[];
    // Position contigue 0..n-1 nell'ordine richiesto.
    expect(body.map((p) => p.id)).toEqual(reversed);
    expect(body.map((p) => p.position)).toEqual(reversed.map((_, i) => i));

    // Persistito nel DB.
    const rows = await testDb.db.select().from(aiProviders);
    const dbById = new Map(rows.map((r) => [r.id, r.position]));
    expect(dbById.get(reversed[0]!)!).toBeLessThan(dbById.get(reversed[1]!)!);
  });

  it("orderedIds incompleto (non copre tutti i provider): 400", async () => {
    const only = await createProvider({ ...basePayload, label: "Reorder Parziale" });
    const id = (only.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: "/api/ai-providers/reorder",
      headers: { cookie: adminCookie },
      payload: { orderedIds: [id] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("un member non può riordinare: 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai-providers/reorder",
      headers: { cookie: memberCookie },
      payload: { orderedIds: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
