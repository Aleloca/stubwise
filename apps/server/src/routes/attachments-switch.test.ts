import { randomBytes } from "node:crypto";
import { changeLog, instanceSettings } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { ObjectStorage } from "../storage/index.js";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Lotto 6, voce 2: l'interruttore d'istanza degli allegati (il prototipo,
 * `setAttachmentsAs`). Accenderlo chiede l'archiviazione configurata; spento,
 * le SCRITTURE dello storage rifiutano (409 `attachments_off`) e leggere
 * resta; `attachmentsEnabled` e `GET /api/storage/uploads` lo dicono.
 */
const KEY = randomBytes(32).toString("base64");
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let users: SeededUsers;
const fake = {
  putObject: vi.fn(async () => undefined),
  putObjectStream: vi.fn(async () => undefined),
  copyObject: vi.fn(async () => undefined),
  getSignedDownloadUrl: vi.fn(async (key: string) => `https://fake/${key}`),
  deleteObject: vi.fn(async () => undefined),
  getObjectBytes: vi.fn(async () => Buffer.from("x")),
} as unknown as ObjectStorage;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: KEY, storageFactory: async () => fake });
  users = await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const call = (method: "GET" | "PUT", url: string, payload?: object, cookie = users.adminCookie) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const view = async () => (await call("GET", "/api/settings/instance")).json() as { attachmentsEnabled: boolean; attachmentsSwitch: boolean };

describe("lotto 6, voce 2: l'interruttore degli allegati", () => {
  it("senza archiviazione configurata non si accende (422 not_set_up); con l'archiviazione sì; spento, le scritture rifiutano e leggere resta", async () => {
    // Di partenza acceso (default della 0228), ma senza archiviazione gli allegati non vanno.
    expect(await view()).toMatchObject({ attachmentsSwitch: true, attachmentsEnabled: false });
    expect((await call("PUT", "/api/settings/instance/attachments", { on: false })).statusCode).toBe(200);
    const refused = await call("PUT", "/api/settings/instance/attachments", { on: true });
    expect([refused.statusCode, (refused.json() as { code: string }).code]).toEqual([422, "not_set_up"]);
    // L'archiviazione configurata: si accende.
    const put = await call("PUT", "/api/settings/instance", { contentLanguage: "en", s3Endpoint: "https://s3.example.com", s3Region: "eu", s3Bucket: "b", s3AccessKey: "AKIA", s3SecretKey: "segreto-lungo" });
    expect(put.statusCode, put.body).toBe(200);
    expect((await call("PUT", "/api/settings/instance/attachments", { on: true })).json()).toMatchObject({ attachmentsSwitch: true, attachmentsEnabled: true });
    expect(((await call("GET", "/api/storage/uploads")).json() as { allowed: boolean }).allowed).toBe(true);
    // Spento: niente caricamenti, la lettura resta.
    expect((await call("PUT", "/api/settings/instance/attachments", { on: false })).json()).toMatchObject({ attachmentsSwitch: false, attachmentsEnabled: false });
    expect(((await call("GET", "/api/storage/uploads")).json() as { allowed: boolean }).allowed).toBe(false);
    const storage = (await app.storage())!;
    await expect(storage.putObject("k", Buffer.from("x"), "text/plain")).rejects.toMatchObject({ statusCode: 409, code: "attachments_off" });
    await expect(storage.copyObject("a", "b")).rejects.toMatchObject({ code: "attachments_off" });
    expect(await storage.getSignedDownloadUrl("k", "f.txt")).toBe("https://fake/k");
    expect(fake.putObject).not.toHaveBeenCalled();
    // La voce del registro, come il prototipo.
    const entries = await t.db.select().from(changeLog).where(eq(changeLog.type, "storage.changed"));
    expect(JSON.stringify(entries.map((e) => e.data))).toContain("attachments");
  });

  it("chi non ha settings.manage: 403, e l'interruttore non cambia", async () => {
    const before = (await t.db.select({ on: instanceSettings.attachmentsSwitch }).from(instanceSettings))[0]!.on;
    expect((await call("PUT", "/api/settings/instance/attachments", { on: !before }, users.memberCookie)).statusCode).toBe(403);
    expect((await t.db.select({ on: instanceSettings.attachmentsSwitch }).from(instanceSettings))[0]!.on).toBe(before);
  });
});
