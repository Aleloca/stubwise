import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { changeLog, decrypt, projectEnvVars, repositories, users } from "@stubwise/db";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import type { TestDb } from "@stubwise/db/testing";
import { seedEnvironment, seedRepository, startTestDb } from "@stubwise/db/testing";
import { addMember, seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let projectId: string;
/** Ambiente `test` del progetto seedato: quello che i file creano di default. */
let environmentId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));

  // I file d'ambiente sono repository-level: `projectId` qui è il repositoryId
  // usato dalle route /api/repositories/:id/env-files. `environmentId` è
  // l'ambiente (fase 8) del PROGETTO di quel repository.
  const { projectId: ownerProjectId, repositoryId } = await seedRepository(testDb.db);
  projectId = repositoryId;
  environmentId = await seedEnvironment(testDb.db, ownerProjectId);
  // Il member è Legacy Member del progetto, come dopo la conversione: un
  // progetto creato dopo la migrazione non ha membri, e non si vedrebbe (404).
  await addMember(app, ownerProjectId, memberId);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createEnvFile(path: string, cookie = adminCookie, pid = projectId, envId = environmentId) {
  return app.inject({
    method: "POST",
    url: `/api/repositories/${pid}/env-files`,
    headers: { cookie },
    payload: { path, environmentId: envId },
  });
}

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";

describe("POST /api/repositories/:id/env-files", () => {
  it("l'admin crea un file env: 201 con { id, environmentId, path, vars: [] }", async () => {
    const res = await createEnvFile(".env");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      environmentId,
      path: ".env",
      vars: [],
    });
  });

  it("path non valido (traversal): 400", async () => {
    expect((await createEnvFile("../x")).statusCode).toBe(400);
  });

  it("path non valido (assoluto): 400", async () => {
    expect((await createEnvFile("/abs")).statusCode).toBe(400);
  });

  it("path non valido (vuoto/spazi): 400", async () => {
    expect((await createEnvFile(" ")).statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await createEnvFile(".env", adminCookie, MISSING_UUID);
    expect(res.statusCode).toBe(404);
  });

  it("ambiente inesistente: 404", async () => {
    const res = await createEnvFile(".env.badenv", adminCookie, projectId, MISSING_UUID);
    expect(res.statusCode).toBe(404);
  });

  it("ambiente di un ALTRO progetto: 404 (non lega un file al posto sbagliato)", async () => {
    const other = await seedRepository(testDb.db);
    const otherEnvironmentId = await seedEnvironment(testDb.db, other.projectId);
    const res = await createEnvFile(".env.crossproject", adminCookie, projectId, otherEnvironmentId);
    expect(res.statusCode).toBe(404);
  });

  it("path duplicato sullo stesso progetto: 409", async () => {
    await createEnvFile(".env.dup");
    const again = await createEnvFile(".env.dup");
    expect(again.statusCode).toBe(409);
  });

  it("stesso path in un ambiente DIVERSO dello stesso repository: ammesso", async () => {
    await createEnvFile(".env.multi");
    const [row] = await testDb.db
      .select({ projectId: repositories.projectId })
      .from(repositories)
      .where(eq(repositories.id, projectId));
    const stagingEnvironmentId = await seedEnvironment(testDb.db, row!.projectId, {
      name: `staging-${Date.now()}`,
      kind: "staging",
    });
    const res = await createEnvFile(".env.multi", adminCookie, projectId, stagingEnvironmentId);
    expect(res.statusCode).toBe(201);
  });

  it("un member non può creare: 403", async () => {
    expect((await createEnvFile(".env.member", memberCookie)).statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files`,
      payload: { path: ".env.anon", environmentId },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/repositories/:id/env-files/:fileId/import", () => {
  it("upsert delle sole chiavi valide, valori cifrati, risposta = chiavi importate", async () => {
    const file = await createEnvFile(".env.import");
    const fileId = (file.json() as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1\nB=2\n# c\nexport C=3\nBAD-KEY=x" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { imported: string[]; count: number };
    expect(body.imported.sort()).toEqual(["A", "B", "C"]);
    expect(body.count).toBe(3);
    // BAD-KEY scartata e mai un valore in chiaro nella risposta.
    expect(res.body).not.toContain("BAD-KEY");
    expect(res.body).not.toContain("value_encrypted");

    // Valori CIFRATI a riposo: round-trip dal DB.
    const rows = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(eq(projectEnvVars.fileId, fileId));
    const byKey = new Map(rows.map((r) => [r.key, r.valueEncrypted]));
    expect([...byKey.keys()].sort()).toEqual(["A", "B", "C"]);
    expect(decrypt(byKey.get("A")!, ENCRYPTION_KEY)).toBe("1");
    expect(decrypt(byKey.get("B")!, ENCRYPTION_KEY)).toBe("2");
    expect(decrypt(byKey.get("C")!, ENCRYPTION_KEY)).toBe("3");
  });

  it("re-import aggiorna le chiavi esistenti senza toccare le altre", async () => {
    const file = await createEnvFile(".env.reimport");
    const fileId = (file.json() as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1\nB=2\nC=3" },
    });
    const [bBefore] = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(and(eq(projectEnvVars.fileId, fileId), eq(projectEnvVars.key, "B")));

    await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=9" },
    });

    const rows = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(eq(projectEnvVars.fileId, fileId));
    const byKey = new Map(rows.map((r) => [r.key, r.valueEncrypted]));
    // A aggiornato, B/C invariati (stesso blob cifrato).
    expect(decrypt(byKey.get("A")!, ENCRYPTION_KEY)).toBe("9");
    expect(byKey.get("B")!).toBe(bBefore!.valueEncrypted);
    expect(decrypt(byKey.get("C")!, ENCRYPTION_KEY)).toBe("3");
  });

  it("file inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${MISSING_UUID}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può importare: 403", async () => {
    const file = await createEnvFile(".env.import.member");
    const fileId = (file.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: memberCookie },
      payload: { content: "A=1" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/repositories/:id/env-files", () => {
  it("ritorna i file con vars { key, valueSet: true }, nessun valore", async () => {
    const file = await createEnvFile(".env.list");
    const fileId = (file.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "SECRET=valore-super-segreto" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${projectId}/env-files`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("valore-super-segreto");
    expect(res.body).not.toContain("value_encrypted");

    const body = res.json() as {
      id: string;
      environmentId: string;
      path: string;
      vars: { key: string; valueSet: boolean }[];
    }[];
    const found = body.find((f) => f.id === fileId);
    expect(found).toBeDefined();
    expect(found!.environmentId).toBe(environmentId);
    expect(found!.path).toBe(".env.list");
    expect(found!.vars).toEqual([{ key: "SECRET", valueSet: true }]);
  });

  it("un member non può leggere: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${projectId}/env-files`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/repositories/:id/env-files/:fileId/vars/:key", () => {
  it("upsert: crea o sostituisce la var cifrata, nessun valore in risposta", async () => {
    const file = await createEnvFile(".env.put");
    const fileId = (file.json() as { id: string }).id;

    const created = await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "primo" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain("primo");

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "nuovo" },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain("nuovo");

    const [row] = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(and(eq(projectEnvVars.fileId, fileId), eq(projectEnvVars.key, "TOKEN")));
    expect(decrypt(row!.valueEncrypted, ENCRYPTION_KEY)).toBe("nuovo");
  });

  it("key non valida nel path-param: 400", async () => {
    const file = await createEnvFile(".env.put.badkey");
    const fileId = (file.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/BAD-KEY`,
      headers: { cookie: adminCookie },
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("file inesistente: 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${MISSING_UUID}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può scrivere: 403", async () => {
    const file = await createEnvFile(".env.put.member");
    const fileId = (file.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: memberCookie },
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE var e file", () => {
  it("DELETE var: 204", async () => {
    const file = await createEnvFile(".env.delvar");
    const fileId = (file.json() as { id: string }).id;
    await app.inject({
      method: "PUT",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "x" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const rows = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(and(eq(projectEnvVars.fileId, fileId), eq(projectEnvVars.key, "TOKEN")));
    expect(rows).toHaveLength(0);
  });

  it("DELETE file: 204 e cascade delle var", async () => {
    const file = await createEnvFile(".env.delfile");
    const fileId = (file.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/repositories/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1\nB=2" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/env-files/${fileId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const rows = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(eq(projectEnvVars.fileId, fileId));
    expect(rows).toHaveLength(0);
  });

  it("DELETE file inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/env-files/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può eliminare il file: 403", async () => {
    const file = await createEnvFile(".env.delfile.member");
    const fileId = (file.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${projectId}/env-files/${fileId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("area 9, F5: la riconferma e il registro dei file d'ambiente", () => {
  const SECRET_VALUE = "valore-segretissimo-9c";
  let stale: string;
  beforeAll(async () => {
    const adminId = (await testDb.db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
    const old = await createSession(testDb.db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
    stale = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
  });
  const call = (method: "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const entries = async (type: string) => testDb.db.select().from(changeLog).where(eq(changeLog.type, type)).orderBy(changeLog.at, changeLog.id);

  it("NEGATIVI: senza una riconferma recente import, imposta, togli ed elimina sono 403 e niente cambia; creare un file VUOTO e leggere i nomi no (D-5)", async () => {
    const created = (await createEnvFile(".env.f5")).json() as { id: string };
    const base = `/api/repositories/${projectId}/env-files`;
    expect((await call("POST", base, stale, { path: ".env.altro", environmentId })).statusCode).toBe(201);
    expect((await call("POST", `${base}/${created.id}/import`, stale, { content: "A=1" })).statusCode).toBe(403);
    expect((await call("PUT", `${base}/${created.id}/vars/API_URL`, stale, { value: SECRET_VALUE })).statusCode).toBe(403);
    expect((await call("DELETE", `${base}/${created.id}/vars/API_URL`, stale)).statusCode).toBe(403);
    expect((await call("DELETE", `${base}/${created.id}`, stale)).statusCode).toBe(403);
    expect(await testDb.db.select().from(projectEnvVars).where(eq(projectEnvVars.fileId, created.id))).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: base, headers: { cookie: stale } })).statusCode).toBe(200);
  });

  it("le voci: creato, importato (quante), variabile impostata e tolta (il NOME, mai il valore), eliminato", async () => {
    const base = `/api/repositories/${projectId}/env-files`;
    const created = (await createEnvFile(".env.registro")).json() as { id: string };
    expect((await entries("env_file.created")).find((e) => e.subjectId === created.id)!.data).toMatchObject({ object: { type: "env_file", id: created.id, label: ".env.registro" }, params: { repository: expect.any(String), environment: expect.any(String) } });
    await call("POST", `${base}/${created.id}/import`, adminCookie, { content: `A=${SECRET_VALUE}\nB=2` });
    expect((await entries("env_file.imported")).at(-1)!.data).toMatchObject({ params: { count: "2" } });
    await call("PUT", `${base}/${created.id}/vars/API_URL`, adminCookie, { value: SECRET_VALUE });
    expect((await entries("env_var.set")).at(-1)!.data).toMatchObject({ params: { variable: "API_URL" } });
    expect((await call("DELETE", `${base}/${created.id}/vars/API_URL`, adminCookie)).statusCode).toBe(204);
    expect((await entries("env_var.removed")).at(-1)!.data).toMatchObject({ params: { variable: "API_URL" } });
    expect((await call("DELETE", `${base}/${created.id}`, adminCookie)).statusCode).toBe(204);
    expect((await entries("env_file.deleted")).at(-1)!.data).toMatchObject({ object: { id: created.id } });
    expect(JSON.stringify(await testDb.db.select().from(changeLog))).not.toContain(SECRET_VALUE);
  });
});
