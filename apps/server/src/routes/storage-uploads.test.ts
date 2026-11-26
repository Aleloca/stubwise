import { randomBytes } from "node:crypto";
import { storageUploadsSchema } from "@stubwise/shared";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * `GET /api/storage/uploads` (registro, r.1121, i blocchi dell'istanza): se un
 * caricamento passerebbe adesso, per i composer della Chat e delle
 * conversazioni con Claude. Lo legge chiunque sia autenticato, e non dice
 * niente della configurazione.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let users: SeededUsers;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const read = (cookie: string) => app.inject({ method: "GET", url: "/api/storage/uploads", headers: { cookie } });

describe("GET /api/storage/uploads", () => {
  it("senza storage configurato: `allowed` false, anche per un member; senza sessione 401", async () => {
    const res = await read(users.memberCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ allowed: false });
    expect((await app.inject({ method: "GET", url: "/api/storage/uploads" })).statusCode).toBe(401);
  });

  it("con lo storage configurato e valido: `allowed` true, e nessun dato della configurazione", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/instance",
      headers: { cookie: users.adminCookie },
      payload: { contentLanguage: "en", s3Endpoint: "https://s3.example.com", s3Region: "eu-central", s3Bucket: "my-bucket", s3AccessKey: "AKIA", s3SecretKey: "super-secret" },
    });
    expect(put.statusCode, put.body).toBe(200);
    const res = await read(users.memberCookie);
    expect(res.json()).toEqual({ allowed: true });
    expect(res.body).not.toContain("my-bucket");
  });

  it("lo schema è additivo: una risposta senza `allowed` (un server di prima) vale true", () => {
    expect(storageUploadsSchema.parse({})).toEqual({ allowed: true });
  });
});
