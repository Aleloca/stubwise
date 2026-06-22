import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { decrypt, projectEnvVars } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PLAINTEXT_TOKEN = "ghp_token-da-non-salvare-in-chiaro";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));

  const account = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: {
      name: "Account GitHub",
      provider: "github",
      credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
    },
  });
  if (account.statusCode !== 201) {
    throw new Error(`creazione account fallita: ${account.statusCode} ${account.body}`);
  }
  const gitAccountId = (account.json() as { id: string }).id;

  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: adminCookie },
    payload: {
      name: "Sito Vetrina",
      gitAccountId,
      repoUrl: "https://github.com/acme/sito-vetrina",
    },
  });
  if (project.statusCode !== 201) {
    throw new Error(`creazione progetto fallita: ${project.statusCode} ${project.body}`);
  }
  projectId = (project.json() as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createEnvFile(path: string, cookie = adminCookie, pid = projectId) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${pid}/env-files`,
    headers: { cookie },
    payload: { path },
  });
}

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";

describe("POST /api/projects/:id/env-files", () => {
  it("l'admin crea un file env: 201 con { id, path, vars: [] }", async () => {
    const res = await createEnvFile(".env");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
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

  it("path duplicato sullo stesso progetto: 409", async () => {
    await createEnvFile(".env.dup");
    const again = await createEnvFile(".env.dup");
    expect(again.statusCode).toBe(409);
  });

  it("un member non può creare: 403", async () => {
    expect((await createEnvFile(".env.member", memberCookie)).statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/env-files`,
      payload: { path: ".env.anon" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/projects/:id/env-files/:fileId/import", () => {
  it("upsert delle sole chiavi valide, valori cifrati, risposta = chiavi importate", async () => {
    const file = await createEnvFile(".env.import");
    const fileId = (file.json() as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1\nB=2\nC=3" },
    });
    const [bBefore] = await testDb.db
      .select()
      .from(projectEnvVars)
      .where(and(eq(projectEnvVars.fileId, fileId), eq(projectEnvVars.key, "B")));

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
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
      url: `/api/projects/${projectId}/env-files/${MISSING_UUID}/import`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: memberCookie },
      payload: { content: "A=1" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/projects/:id/env-files", () => {
  it("ritorna i file con vars { key, valueSet: true }, nessun valore", async () => {
    const file = await createEnvFile(".env.list");
    const fileId = (file.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "SECRET=valore-super-segreto" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/env-files`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("valore-super-segreto");
    expect(res.body).not.toContain("value_encrypted");

    const body = res.json() as { id: string; path: string; vars: { key: string; valueSet: boolean }[] }[];
    const found = body.find((f) => f.id === fileId);
    expect(found).toBeDefined();
    expect(found!.path).toBe(".env.list");
    expect(found!.vars).toEqual([{ key: "SECRET", valueSet: true }]);
  });

  it("un member non può leggere: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/env-files`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/projects/:id/env-files/:fileId/vars/:key", () => {
  it("upsert: crea o sostituisce la var cifrata, nessun valore in risposta", async () => {
    const file = await createEnvFile(".env.put");
    const fileId = (file.json() as { id: string }).id;

    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "primo" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain("primo");

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/TOKEN`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/BAD-KEY`,
      headers: { cookie: adminCookie },
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("file inesistente: 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/env-files/${MISSING_UUID}/vars/TOKEN`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/TOKEN`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/TOKEN`,
      headers: { cookie: adminCookie },
      payload: { value: "x" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/env-files/${fileId}/vars/TOKEN`,
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
      url: `/api/projects/${projectId}/env-files/${fileId}/import`,
      headers: { cookie: adminCookie },
      payload: { content: "A=1\nB=2" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/env-files/${fileId}`,
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
      url: `/api/projects/${projectId}/env-files/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può eliminare il file: 403", async () => {
    const file = await createEnvFile(".env.delfile.member");
    const fileId = (file.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/env-files/${fileId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
