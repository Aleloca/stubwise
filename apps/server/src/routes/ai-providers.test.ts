import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiProviders, aiUsageSnapshots, changeLog, decrypt, projects } from "@stubwise/db";
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
      testStatus: "idle",
      testRequestedAt: null,
      testCheckedAt: null,
      testError: null,
      lastEnabled: expect.any(Boolean),
      last4: PLAINTEXT_SECRET.slice(-4),
      limitedUntil: null,
      quotaBand: "ok",
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

describe("POST /api/ai-providers/:id/test", () => {
  it("marca la richiesta di test: 200, status pending, testRequestedAt valorizzato", async () => {
    const created = await createProvider({ ...basePayload, label: "Da Testare" });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: `/api/ai-providers/${id}/test`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; testStatus: string; testRequestedAt: string | null };
    expect(body.id).toBe(id);
    expect(body.testStatus).toBe("pending");
    expect(body.testRequestedAt).toEqual(expect.any(String));
    // La secret non trapela nemmeno qui.
    expect(res.body).not.toContain(PLAINTEXT_SECRET);
    expect(res.body).not.toContain("secretEncrypted");

    // Persistito: il worker raccoglierà questa riga.
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.testStatus).toBe("pending");
    expect(row!.testRequestedAt).not.toBeNull();
  });

  it("ripristina lo stato a pending anche se l'ultimo test era failed", async () => {
    const created = await createProvider({ ...basePayload, label: "Ritesta" });
    const id = (created.json() as { id: string }).id;
    // Simula un esito precedente fallito scritto dal worker.
    await testDb.db
      .update(aiProviders)
      .set({ testStatus: "failed", testError: "boom", testCheckedAt: new Date() })
      .where(eq(aiProviders.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/api/ai-providers/${id}/test`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { testStatus: string }).testStatus).toBe("pending");
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.testStatus).toBe("pending");
    // L'errore precedente è azzerato (parte un nuovo test pulito).
    expect(row!.testError).toBeNull();
  });

  it("provider inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai-providers/00000000-0000-0000-0000-000000000000/test",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può richiedere il test: 403", async () => {
    const created = await createProvider({ ...basePayload, label: "Protetto Test" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/ai-providers/${id}/test`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const created = await createProvider({ ...basePayload, label: "Anon Test" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({ method: "POST", url: `/api/ai-providers/${id}/test` });
    expect(res.statusCode).toBe(401);
  });

  it("GET espone lo stato del test (testStatus/testError/testCheckedAt) senza secret", async () => {
    const created = await createProvider({ ...basePayload, label: "Stato Test" });
    const id = (created.json() as { id: string }).id;
    // Esito scritto dal worker.
    await testDb.db
      .update(aiProviders)
      .set({ testStatus: "failed", testError: "Invalid API key", testCheckedAt: new Date() })
      .where(eq(aiProviders.id, id));

    const list = await app.inject({
      method: "GET",
      url: "/api/ai-providers",
      headers: { cookie: adminCookie },
    });
    const body = list.json() as {
      id: string;
      testStatus: string;
      testError: string | null;
      testCheckedAt: string | null;
    }[];
    const found = body.find((p) => p.id === id);
    expect(found!.testStatus).toBe("failed");
    expect(found!.testError).toBe("Invalid API key");
    expect(found!.testCheckedAt).toEqual(expect.any(String));
    expect(list.body).not.toContain("secretEncrypted");
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

  it("azzera «solo questo» sui progetti che usavano il provider, e lascia gli altri", async () => {
    const mine = await createProvider({ ...basePayload, label: "Esclusivo A" });
    const other = await createProvider({ ...basePayload, label: "Esclusivo B" });
    const idA = (mine.json() as { id: string }).id;
    const idB = (other.json() as { id: string }).id;
    const [pa] = await testDb.db
      .insert(projects)
      .values({ name: "Pa", slug: "excl-pa", ingestionKey: "excl-pa-key", aiProviderId: idA, aiProviderExclusive: true })
      .returning({ id: projects.id });
    const [pb] = await testDb.db
      .insert(projects)
      .values({ name: "Pb", slug: "excl-pb", ingestionKey: "excl-pb-key", aiProviderId: idB, aiProviderExclusive: true })
      .returning({ id: projects.id });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/ai-providers/${idA}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const [a] = await testDb.db.select().from(projects).where(eq(projects.id, pa!.id));
    const [b] = await testDb.db.select().from(projects).where(eq(projects.id, pb!.id));
    expect(a).toMatchObject({ aiProviderId: null, aiProviderExclusive: false });
    expect(b).toMatchObject({ aiProviderId: idB, aiProviderExclusive: true });
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

  it("revisione del lotto 2, M5: due riordini insieme si mettono in fila (lock sulle righe): nel registro il «prima» del secondo è il «dopo» del primo", async () => {
    const reorder = (orderedIds: string[]) => app.inject({ method: "POST", url: "/api/ai-providers/reorder", headers: { cookie: adminCookie }, payload: { orderedIds } });
    for (let i = 0; i < 3; i++) await createProvider({ ...basePayload, label: `Fila ${i}` });
    const current = ((await app.inject({ method: "GET", url: "/api/ai-providers", headers: { cookie: adminCookie } })).json() as { id: string }[]).map((p) => p.id);
    for (let round = 0; round < 5; round++) {
      const a = [...current].reverse();
      const b = [current[1]!, current[0]!, ...current.slice(2)];
      // Ognuno dei due cambia l'ordine di adesso, qualunque sia.
      await reorder(current);
      const [ra, rb] = await Promise.all([reorder(a), reorder(b)]);
      expect([ra.statusCode, rb.statusCode], ra.body + rb.body).toEqual([200, 200]);
      const entries = await testDb.db.select().from(changeLog).where(eq(changeLog.type, "provider.reordered")).orderBy(changeLog.at);
      // `at` può essere l'inizio della transazione (chi ha aspettato è partito prima):
      // l'ordine vero è quello della catena, in un verso o nell'altro.
      const [x, y] = entries.slice(-2).map((e) => e.data as { before: string; after: string });
      expect(y!.before === x!.after || x!.before === y!.after, JSON.stringify([x, y])).toBe(true);
    }
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

describe("area 9, F3, Task 8c: l'ultimo acceso, le ultime 4 cifre, la banda della quota", () => {
  const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/ai-providers/${id}`, headers: { cookie: adminCookie }, payload });
  const del = (id: string) => app.inject({ method: "DELETE", url: `/api/ai-providers/${id}`, headers: { cookie: adminCookie } });
  const list = async () => (await app.inject({ method: "GET", url: "/api/ai-providers", headers: { cookie: adminCookie } })).json() as Record<string, unknown>[];

  it("l'unico acceso non si spegne né si elimina (409 last_enabled_provider), e la vista lo dice; con un secondo acceso sì", async () => {
    await testDb.db.update(projects).set({ aiProviderId: null });
    await testDb.db.delete(aiProviders);
    const a = (await createProvider({ ...basePayload, label: "A" })).json() as { id: string };
    expect((await list())[0]).toMatchObject({ id: a.id, lastEnabled: true });
    const off = await patch(a.id, { enabled: false });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: "last_enabled_provider" });
    expect((await del(a.id)).statusCode).toBe(409);
    const [still] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, a.id));
    expect(still!.enabled).toBe(true);

    const b = (await createProvider({ ...basePayload, label: "B" })).json() as { id: string };
    expect((await list()).map((p) => p.lastEnabled)).toEqual([false, false]);
    expect((await patch(a.id, { enabled: false })).statusCode).toBe(200);
    expect((await list()).find((p) => p.id === b.id)).toMatchObject({ lastEnabled: true });
    // Un account SPENTO si elimina anche se ne resta uno solo acceso.
    expect((await del(a.id)).statusCode).toBe(204);
    expect((await del(b.id)).statusCode).toBe(409);
  });

  it("le ultime 4 cifre: alla creazione e alla sostituzione; una riga di prima resta null; mai il segreto", async () => {
    const p = (await createProvider({ ...basePayload, label: "C", secret: "sk-ant-1234567890abcd" })).json() as { id: string; last4: string };
    expect(p.last4).toBe("abcd");
    const replaced = await patch(p.id, { secret: "sk-ant-0000000000wxyz" });
    expect(replaced.json()).toMatchObject({ last4: "wxyz" });
    expect(replaced.body).not.toContain("sk-ant-0000000000wxyz");
    await testDb.db.update(aiProviders).set({ secretLast4: null }).where(eq(aiProviders.id, p.id));
    expect((await list()).find((x) => x.id === p.id)).toMatchObject({ last4: null });
  });

  it("la banda: limited se fermo per il limite, near dall'80% (sessione o settimana), altrimenti ok", async () => {
    const p = (await createProvider({ ...basePayload, kind: "account", label: "Abbonamento" })).json() as { id: string };
    const band = async () => (await list()).find((x) => x.id === p.id)!.quotaBand;
    expect(await band()).toBe("ok");
    await testDb.db.insert(aiUsageSnapshots).values({ providerId: p.id, sessionRemaining: { percentUsed: 20, percentRemaining: 80 }, weeklyRemaining: { percentUsed: 79, percentRemaining: 21 }, source: "deterministic", parseOk: true, capturedAt: new Date(Date.now() - 60_000) });
    expect(await band()).toBe("ok");
    await testDb.db.insert(aiUsageSnapshots).values({ providerId: p.id, sessionRemaining: { percentUsed: 10, percentRemaining: 90 }, weeklyRemaining: { percentUsed: 80, percentRemaining: 20 }, source: "deterministic", parseOk: true });
    expect(await band()).toBe("near");
    const until = new Date(Date.now() + 3_600_000);
    await testDb.db.update(aiProviders).set({ limitedUntil: until }).where(eq(aiProviders.id, p.id));
    expect((await list()).find((x) => x.id === p.id)).toMatchObject({ quotaBand: "limited", limitedUntil: until.toISOString() });
    await testDb.db.update(aiProviders).set({ limitedUntil: new Date(Date.now() - 1000) }).where(eq(aiProviders.id, p.id));
    expect(await band()).toBe("near");
  });
});
