import { randomUUID } from "node:crypto";
import { users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 7 (D-13; docs/invariants/identity.md, «La foto è
 * un'immagine, mai un documento»): PNG, JPEG o WebP DEDOTTI dai byte, al più
 * 512 KB, mai SVG né GIF, serviti col tipo dedotto, `nosniff` e una CSP che non
 * esegue niente, alla stessa visibilità delle persone.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 2).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(64, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 4)]);

async function person() {
  const [u] = await db.insert(users).values({ email: `a-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, cookie: await fullSessionCookie(app, u!.id) };
}
const upload = (cookie: string, body: Buffer, type = "image/png") =>
  app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie, "content-type": type }, payload: body });
const fetchAvatar = (cookie: string, id: string) => app.inject({ method: "GET", url: `/api/users/${id}/avatar`, headers: { cookie } });
const meAvatar = async (cookie: string) =>
  ((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json() as { user: { avatarUrl: string | null } }).user.avatarUrl;

describe("la foto del profilo", () => {
  it("PNG, JPEG e WebP entrano; si servono col tipo DEDOTTO e con gli header che non eseguono niente", async () => {
    const p = await person();
    for (const [body, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [WEBP, "image/webp"]] as const) {
      // Il tipo dichiarato non conta: lo si manda «sbagliato» apposta.
      expect((await upload(p.cookie, body, "application/octet-stream")).statusCode).toBe(204);
      const res = await fetchAvatar(p.cookie, p.id);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe(type);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(String(res.headers["content-security-policy"])).toContain("sandbox");
      expect(res.rawPayload.equals(body)).toBe(true);
    }
    expect(await meAvatar(p.cookie)).toMatch(new RegExp(`^/api/users/${p.id}/avatar\\?v=\\d+$`));
  });

  it("NEGATIVI: un SVG (anche dichiarato PNG), un HTML, un GIF → 415; oltre 512 KB → 413; niente salvato", async () => {
    const p = await person();
    for (const body of [SVG, HTML, GIF]) {
      const res = await upload(p.cookie, body, "image/png");
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ code: "unsupported_image" });
    }
    const big = Buffer.concat([PNG, Buffer.alloc(524_288 - PNG.length + 1, 0)]);
    expect((await upload(p.cookie, big)).statusCode).toBe(413);
    expect((await fetchAvatar(p.cookie, p.id)).statusCode).toBe(404);
    expect(await meAvatar(p.cookie)).toBeNull();
  });

  it("eliminarla: 204, poi 404 e niente più avatarUrl", async () => {
    const p = await person();
    await upload(p.cookie, PNG);
    expect((await app.inject({ method: "DELETE", url: "/api/me/avatar", headers: { cookie: p.cookie } })).statusCode).toBe(204);
    expect((await fetchAvatar(p.cookie, p.id)).statusCode).toBe(404);
    expect(await meAvatar(p.cookie)).toBeNull();
  });

  it("la stessa visibilità delle persone: chi condivide un progetto la vede, chi no riceve 404; senza sessione 401", async () => {
    const { projectId } = await seedRepository(db);
    const { projectId: other } = await seedRepository(db);
    const owner = await person();
    const colleague = await person();
    const stranger = await person();
    await addMember(app, projectId, owner.id, "developer");
    await addMember(app, projectId, colleague.id, "developer");
    await addMember(app, other, stranger.id, "developer");
    await upload(owner.cookie, PNG);
    expect((await fetchAvatar(colleague.cookie, owner.id)).statusCode).toBe(200);
    expect((await fetchAvatar(stranger.cookie, owner.id)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/users/${owner.id}/avatar` })).statusCode).toBe(401);
    const people = (await app.inject({ method: "GET", url: "/api/people", headers: { cookie: colleague.cookie } })).json() as { id: string; avatarUrl?: string | null }[];
    expect(people.find((x) => x.id === owner.id)?.avatarUrl).toMatch(/\/avatar\?v=/);
  });
});
