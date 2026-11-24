import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  personalAccessTokens,
  securityEvents,
  vaultDevicePairings,
  vaultDeviceSeals,
  vaultPersonKeys,
  vaultSettings,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import {
  generateDeviceKeyPair,
  generatePersonKeyPair,
  importDeviceKey,
  openActorChallenge,
  openDeviceSeal,
  sealForDevice,
  sealPrivateKey,
} from "@stubwise/vault-crypto";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { listInbox } from "../services/inbox.js";
import { createUserWithSession, fullSessionCookie, seedUsers } from "../test/fixtures.js";
import { createPatForUser } from "./pat.js";

/**
 * La cassaforte dal desktop, lato server (lotto 10,
 * `docs/plans/2026-11-24-cassaforte-desktop-design.md` §6, §8, §10): come
 * nasce il sigillo di un Mac, chi lo scarica, chi lo toglie. I NEGATIVI
 * prima: ogni rifiuto verifica anche che nulla sia stato scritto.
 */

let testDb: TestDb;
let app: FastifyInstance;
let adminId: string;
let adminCookie: string;

type Person = {
  id: string;
  cookie: string;
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
  /** Il sigillo della passkey e il suo PRF: servono a `sealForDevice`, come nel browser. */
  passkeySeal: string;
  prf: ArrayBuffer;
  desktop: { id: string; headers: { authorization: string } };
};

let ada: Person;
let bob: Person;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function publicJwk(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

async function pat(userId: string, kind: "desktop" | "mobile" | "manual") {
  const created = await createPatForUser(testDb.db, userId, `T ${kind} ${randomBytes(3).toString("hex")}`, null, kind);
  return { id: created.id, headers: bearer(created.token) };
}

async function person(email: string): Promise<Person> {
  const user = await createUserWithSession(app, email);
  const pair = await generatePersonKeyPair();
  const prf = crypto.getRandomValues(new Uint8Array(32)).buffer;
  const passkeySeal = await sealPrivateKey(prf, pair.privateKeyPkcs8, pair.publicKey);
  const [key] = await testDb.db
    .insert(vaultPersonKeys)
    .values({ userId: user.id, publicKey: pair.publicKey, status: "confirmed", confirmedAt: new Date() })
    .returning({ id: vaultPersonKeys.id });
  return {
    id: user.id,
    cookie: user.headers.cookie,
    keyId: key!.id,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    passkeySeal,
    prf,
    desktop: await pat(user.id, "desktop"),
  };
}

function call(method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
}

async function staleCookie(userId: string): Promise<string> {
  const old = await createSession(testDb.db, userId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}

async function actorProof(p: Person) {
  const res = await call("POST", "/api/vault/actor-challenge", { cookie: p.cookie });
  expect(res.statusCode, res.body).toBe(201);
  const { challengeId, wrapped, personKeyId } = res.json() as { challengeId: string; wrapped: string; personKeyId: string };
  return { challengeId, proof: await openActorChallenge(wrapped, p.privateKey, challengeId, personKeyId) };
}

/** Il main chiede l'associazione col SUO PAT desktop. */
async function pairing(p: Person, devicePublicKey?: string) {
  const device = await generateDeviceKeyPair();
  const res = await call("POST", "/api/vault/device-pairings", p.desktop.headers, {
    devicePublicKey: devicePublicKey ?? device.publicKey,
    deviceName: "MacBook di prova",
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { state: string; deviceId: string };
  return { ...body, device };
}

/** Il browser sigilla davvero (`sealForDevice`) per quell'associazione. */
async function sealBody(p: Person, pair: Awaited<ReturnType<typeof pairing>>) {
  const seal = await sealForDevice({
    prfOutput: p.prf,
    sealed: p.passkeySeal,
    personPublicKey: p.publicKey,
    personKeyId: p.keyId,
    devicePublicKey: pair.device.publicKey,
    deviceId: pair.deviceId,
  });
  return { pairingState: pair.state, deviceId: pair.deviceId, seal, actorProof: await actorProof(p) };
}

async function sealsOf(userId: string) {
  return testDb.db.select().from(vaultDeviceSeals).where(eq(vaultDeviceSeals.userId, userId));
}

async function events(userId: string, kind: "vault_device_sealed" | "vault_device_seal_revoked") {
  return testDb.db
    .select()
    .from(securityEvents)
    .where(and(eq(securityEvents.userId, userId), eq(securityEvents.kind, kind)));
}

async function alerts(userId: string) {
  return (await listInbox(testDb.db, { userId, lang: "en" })).items.filter((i) => i.kind === "security.alert");
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminId } = await seedUsers(app));
  adminCookie = await fullSessionCookie(app, adminId);
  ada = await person("ada-device@example.com");
  bob = await person("bob-device@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("l'associazione (POST /api/vault/device-pairings): la chiede SOLO il PAT desktop", () => {
  it("cassaforte non attiva → 409 `vault_not_active`, niente scritto", async () => {
    const res = await call("POST", "/api/vault/device-pairings", ada.desktop.headers, { devicePublicKey: publicJwk(), deviceName: "Mac" });
    expect([res.statusCode, res.json().code]).toEqual([409, "vault_not_active"]);
    expect(await testDb.db.select().from(vaultDevicePairings)).toHaveLength(0);
    await testDb.db.insert(vaultSettings).values({ recoveryPublicKey: publicJwk(), activatedByUserId: adminId });
  });

  it("un PAT `manual` o `mobile` → 403 `session_required`; una sessione del browser → 403 `desktop_required`; niente scritto", async () => {
    for (const kind of ["manual", "mobile"] as const) {
      const res = await call("POST", "/api/vault/device-pairings", (await pat(ada.id, kind)).headers, { devicePublicKey: publicJwk(), deviceName: "Mac" });
      expect([res.statusCode, res.json().code], kind).toEqual([403, "session_required"]);
    }
    const browser = await call("POST", "/api/vault/device-pairings", { cookie: ada.cookie }, { devicePublicKey: publicJwk(), deviceName: "Mac" });
    expect([browser.statusCode, browser.json().code]).toEqual([403, "desktop_required"]);
    expect(await testDb.db.select().from(vaultDevicePairings)).toHaveLength(0);
  });

  it("una pubblica che non è una pubblica P-256 (o una PRIVATA) → 400, niente scritto", async () => {
    const priv = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    for (const devicePublicKey of ["nope", JSON.stringify(priv)]) {
      const res = await call("POST", "/api/vault/device-pairings", ada.desktop.headers, { devicePublicKey, deviceName: "Mac" });
      expect(res.statusCode).toBe(400);
    }
    expect(await testDb.db.select().from(vaultDevicePairings)).toHaveLength(0);
  });

  it("il PAT desktop la ottiene; sul server resta solo l'HASH dello state, legato a quel PAT", async () => {
    const pair = await pairing(ada);
    const [row] = await testDb.db.select().from(vaultDevicePairings).where(eq(vaultDevicePairings.id, pair.deviceId));
    expect(row).toMatchObject({ userId: ada.id, patId: ada.desktop.id, usedAt: null });
    expect(row!.stateHash).not.toContain(pair.state);
    expect(row!.stateHash).toBe(createHash("sha256").update(pair.state).digest("hex"));
  });

  it("una nuova associazione dallo stesso PAT annulla la precedente non usata", async () => {
    const first = await pairing(ada);
    await pairing(ada);
    const res = await call("POST", "/api/vault/device-pairings/lookup", { cookie: ada.cookie }, { state: first.state });
    expect([res.statusCode, res.json().code]).toEqual([404, "pairing_invalid"]);
  });
});

describe("la lettura dell'associazione (POST /api/vault/device-pairings/lookup): solo il browser della STESSA persona", () => {
  it("un PAT (anche desktop) → 403 `session_required`", async () => {
    const pair = await pairing(ada);
    const res = await call("POST", "/api/vault/device-pairings/lookup", ada.desktop.headers, { state: pair.state });
    expect([res.statusCode, res.json().code]).toEqual([403, "session_required"]);
  });

  it("lo state di un'ALTRA persona, uno inventato o uno scaduto → 404 `pairing_invalid`", async () => {
    const pair = await pairing(ada);
    const other = await call("POST", "/api/vault/device-pairings/lookup", { cookie: bob.cookie }, { state: pair.state });
    expect([other.statusCode, other.json().code]).toEqual([404, "pairing_invalid"]);
    const unknown = await call("POST", "/api/vault/device-pairings/lookup", { cookie: ada.cookie }, { state: randomBytes(32).toString("base64url") });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "pairing_invalid"]);
    await testDb.db.update(vaultDevicePairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(vaultDevicePairings.id, pair.deviceId));
    const expired = await call("POST", "/api/vault/device-pairings/lookup", { cookie: ada.cookie }, { state: pair.state });
    expect([expired.statusCode, expired.json().code]).toEqual([404, "pairing_invalid"]);
  });

  it("la propria: pubblica e nome del Mac DAL SERVER (non dall'URL)", async () => {
    const pair = await pairing(ada);
    const res = await call("POST", "/api/vault/device-pairings/lookup", { cookie: ada.cookie }, { state: pair.state });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ deviceId: pair.deviceId, deviceName: "MacBook di prova", devicePublicKey: pair.device.publicKey });
  });
});

describe("il sigillo (POST /api/vault/device-seals): nasce SOLO dal browser, con la prova della propria chiave", () => {
  it("dal PAT desktop → 403 `session_required` (un Mac non si associa da sé); niente scritto", async () => {
    const pair = await pairing(ada);
    const res = await call("POST", "/api/vault/device-seals", ada.desktop.headers, await sealBody(ada, pair));
    expect([res.statusCode, res.json().code]).toEqual([403, "session_required"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
  });

  it("da una sessione senza riconferma recente → 403 `reauth_required`; niente scritto", async () => {
    const pair = await pairing(ada);
    const res = await call("POST", "/api/vault/device-seals", { cookie: await staleCookie(ada.id) }, await sealBody(ada, pair));
    expect([res.statusCode, res.json().code]).toEqual([403, "reauth_required"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
  });

  it("senza una prova valida → 403 `vault_proof_invalid`; niente scritto e l'associazione resta usabile", async () => {
    const pair = await pairing(ada);
    const body = await sealBody(ada, pair);
    const res = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, { ...body, actorProof: { challengeId: randomUUID(), proof: randomBytes(32).toString("base64url") } });
    expect([res.statusCode, res.json().code]).toEqual([403, "vault_proof_invalid"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
    const [row] = await testDb.db.select().from(vaultDevicePairings).where(eq(vaultDevicePairings.id, pair.deviceId));
    expect(row!.usedAt).toBeNull();
  });

  it("lo state dell'associazione di un'ALTRA persona → 409 `pairing_invalid`, anche con la propria prova; niente scritto", async () => {
    const bobPair = await pairing(bob);
    const body = await sealBody(ada, bobPair);
    const res = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, body);
    expect([res.statusCode, res.json().code]).toEqual([409, "pairing_invalid"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
    expect(await sealsOf(bob.id)).toHaveLength(0);
  });

  it("un `deviceId` che non è quello dell'associazione, o un'associazione scaduta → 409 `pairing_invalid`", async () => {
    const pair = await pairing(ada);
    const wrong = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, { ...(await sealBody(ada, pair)), deviceId: randomUUID() });
    expect([wrong.statusCode, wrong.json().code]).toEqual([409, "pairing_invalid"]);
    await testDb.db.update(vaultDevicePairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(vaultDevicePairings.id, pair.deviceId));
    const expired = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, await sealBody(ada, pair));
    expect([expired.statusCode, expired.json().code]).toEqual([409, "pairing_invalid"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
  });

  it("il PAT dell'associazione revocato nel frattempo → 409 `pairing_invalid` (l'associazione sparisce col PAT)", async () => {
    const extra = await pat(ada.id, "desktop");
    const device = await generateDeviceKeyPair();
    const res = await call("POST", "/api/vault/device-pairings", extra.headers, { devicePublicKey: device.publicKey, deviceName: "Mac" });
    const pair = { ...(res.json() as { state: string; deviceId: string }), device };
    const body = await sealBody(ada, pair);
    await testDb.db.delete(personalAccessTokens).where(eq(personalAccessTokens.id, extra.id));
    const sealed = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, body);
    expect([sealed.statusCode, sealed.json().code]).toEqual([409, "pairing_invalid"]);
    expect(await sealsOf(ada.id)).toHaveLength(0);
  });

  it("chi non ha una chiave CONFERMATA → 403 `vault_key_not_confirmed`; niente scritto", async () => {
    const carl = await person("carl-device@example.com");
    const proof = await actorProof(carl);
    await testDb.db.update(vaultPersonKeys).set({ status: "pending", confirmedAt: null }).where(eq(vaultPersonKeys.id, carl.keyId));
    const pair = await pairing(carl);
    const res = await call("POST", "/api/vault/device-seals", { cookie: carl.cookie }, { pairingState: pair.state, deviceId: pair.deviceId, seal: JSON.stringify({ v: 1, x: "AA" }), actorProof: proof });
    expect([res.statusCode, res.json().code]).toEqual([403, "vault_key_not_confirmed"]);
    expect(await sealsOf(carl.id)).toHaveLength(0);
  });

  it("riesce: la riga è legata alla persona, alla chiave CONFERMATA attuale e al PAT dell'associazione; registro, avviso, associazione consumata", async () => {
    const pair = await pairing(ada);
    const res = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, await sealBody(ada, pair));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ id: pair.deviceId, deviceName: "MacBook di prova" });
    const [row] = await sealsOf(ada.id);
    expect(row).toMatchObject({ id: pair.deviceId, personKeyId: ada.keyId, patId: ada.desktop.id, devicePublicKey: pair.device.publicKey, revokedAt: null });
    expect(await events(ada.id, "vault_device_sealed")).toHaveLength(1);
    expect((await alerts(ada.id)).length).toBeGreaterThan(0);
    // Lo stesso state non si usa due volte.
    const again = await call("POST", "/api/vault/device-seals", { cookie: ada.cookie }, await sealBody(ada, pair));
    expect([again.statusCode, again.json().code]).toEqual([409, "pairing_invalid"]);
  });
});

describe("il proprio sigillo (GET/DELETE /api/vault/device-seals/mine): solo il PAT desktop a cui è legato", () => {
  it("un PAT `manual`/`mobile` → 403 `session_required`; una sessione → 403 `desktop_required`", async () => {
    for (const kind of ["manual", "mobile"] as const) {
      const res = await call("GET", "/api/vault/device-seals/mine", (await pat(ada.id, kind)).headers);
      expect([res.statusCode, res.json().code], kind).toEqual([403, "session_required"]);
    }
    const browser = await call("GET", "/api/vault/device-seals/mine", { cookie: ada.cookie });
    expect([browser.statusCode, browser.json().code]).toEqual([403, "desktop_required"]);
  });

  it("un ALTRO PAT desktop della stessa persona non scarica il sigillo legato al primo (404 `device_seal_not_found`)", async () => {
    const other = await pat(ada.id, "desktop");
    const res = await call("GET", "/api/vault/device-seals/mine", other.headers);
    expect([res.statusCode, res.json().code]).toEqual([404, "device_seal_not_found"]);
  });

  it("il PAT desktop giusto lo scarica e il Mac lo APRE davvero (andata e ritorno con le primitive)", async () => {
    const pair = await pairing(bob);
    expect((await call("POST", "/api/vault/device-seals", { cookie: bob.cookie }, await sealBody(bob, pair))).statusCode).toBe(201);
    const res = await call("GET", "/api/vault/device-seals/mine", bob.desktop.headers);
    expect(res.statusCode, res.body).toBe(200);
    const mine = res.json() as { id: string; personKeyId: string; personPublicKey: string; seal: string };
    expect(mine).toMatchObject({ id: pair.deviceId, personKeyId: bob.keyId, personPublicKey: bob.publicKey });
    const opened = await openDeviceSeal({
      deviceSeal: mine.seal,
      devicePrivateKey: await importDeviceKey(pair.device.privateKeyPkcs8),
      personPublicKey: mine.personPublicKey,
      personKeyId: mine.personKeyId,
      deviceId: mine.id,
    });
    expect(opened.extractable).toBe(false);
    const [row] = await sealsOf(bob.id);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("revoca a LETTURA: chiave di persona ricreata → 404 anche con la riga del sigillo ancora viva", async () => {
    const dan = await person("dan-device@example.com");
    const pair = await pairing(dan);
    expect((await call("POST", "/api/vault/device-seals", { cookie: dan.cookie }, await sealBody(dan, pair))).statusCode).toBe(201);
    await testDb.db.update(vaultPersonKeys).set({ status: "superseded" }).where(eq(vaultPersonKeys.id, dan.keyId));
    await testDb.db.insert(vaultPersonKeys).values({ userId: dan.id, publicKey: publicJwk(), status: "confirmed", confirmedAt: new Date() });
    const res = await call("GET", "/api/vault/device-seals/mine", dan.desktop.headers);
    expect([res.statusCode, res.json().code]).toEqual([404, "device_seal_not_found"]);
    const [row] = await sealsOf(dan.id);
    expect(row!.revokedAt).toBeNull();
  });

  it("«Dimentica questo Mac»: DELETE mine → 204, poi 404; il motivo è `forgotten`, il registro lo dice; di nuovo → 204", async () => {
    expect((await call("DELETE", "/api/vault/device-seals/mine", bob.desktop.headers)).statusCode).toBe(204);
    const res = await call("GET", "/api/vault/device-seals/mine", bob.desktop.headers);
    expect([res.statusCode, res.json().code]).toEqual([404, "device_seal_not_found"]);
    const [row] = await sealsOf(bob.id);
    expect(row).toMatchObject({ revokedReason: "forgotten" });
    expect(await events(bob.id, "vault_device_seal_revoked")).toHaveLength(1);
    expect((await call("DELETE", "/api/vault/device-seals/mine", bob.desktop.headers)).statusCode).toBe(204);
    expect(await events(bob.id, "vault_device_seal_revoked")).toHaveLength(1);
  });

  it("DELETE mine col PAT di un'altra persona non tocca il sigillo di Ada", async () => {
    expect((await call("DELETE", "/api/vault/device-seals/mine", bob.desktop.headers)).statusCode).toBe(204);
    const [row] = await sealsOf(ada.id);
    expect(row!.revokedAt).toBeNull();
  });
});

describe("i Mac dal browser (GET /api/vault/device-seals, DELETE /api/vault/device-seals/:id): D-5, il SOLO sigillo", () => {
  it("l'elenco ha solo i propri Mac vivi", async () => {
    const res = await call("GET", "/api/vault/device-seals", { cookie: ada.cookie });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toEqual((await sealsOf(ada.id)).filter((s) => !s.revokedAt).map((s) => s.id));
  });

  it("un PAT (anche desktop) non elenca né toglie: 403 `session_required`", async () => {
    const [row] = await sealsOf(ada.id);
    expect((await call("GET", "/api/vault/device-seals", ada.desktop.headers)).json().code).toBe("session_required");
    expect((await call("DELETE", `/api/vault/device-seals/${row!.id}`, ada.desktop.headers)).json().code).toBe("session_required");
  });

  it("il Mac di un'altra persona → 404, intatto; senza riconferma recente → 403 `reauth_required`", async () => {
    const [row] = await sealsOf(ada.id);
    const other = await call("DELETE", `/api/vault/device-seals/${row!.id}`, { cookie: bob.cookie });
    expect(other.statusCode).toBe(404);
    const stale = await call("DELETE", `/api/vault/device-seals/${row!.id}`, { cookie: await staleCookie(ada.id) });
    expect([stale.statusCode, stale.json().code]).toEqual([403, "reauth_required"]);
    expect((await sealsOf(ada.id))[0]!.revokedAt).toBeNull();
  });

  it("toglierlo dal browser revoca il SOLO sigillo: il Mac resta collegato (il suo PAT funziona), ma non scarica più il sigillo", async () => {
    const [row] = await sealsOf(ada.id);
    expect((await call("DELETE", `/api/vault/device-seals/${row!.id}`, { cookie: ada.cookie })).statusCode).toBe(204);
    expect((await sealsOf(ada.id))[0]).toMatchObject({ revokedReason: "removed" });
    expect((await call("GET", "/api/auth/me", ada.desktop.headers)).statusCode).toBe(200);
    expect((await call("GET", "/api/vault/device-seals/mine", ada.desktop.headers)).statusCode).toBe(404);
    expect(await events(ada.id, "vault_device_seal_revoked")).toHaveLength(1);
  });

  it("riassociare dallo stesso PAT: il sigillo vivo precedente diventa `replaced`, ne resta uno", async () => {
    const eve = await person("eve-device@example.com");
    for (let i = 0; i < 2; i++) {
      const pair = await pairing(eve);
      expect((await call("POST", "/api/vault/device-seals", { cookie: eve.cookie }, await sealBody(eve, pair))).statusCode).toBe(201);
    }
    const rows = await sealsOf(eve.id);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.revokedReason === "replaced")).toHaveLength(1);
  });
});

describe("i Mac di un'altra persona, da un full admin (D-6)", () => {
  let fay: Person;
  let sealId: string;

  beforeAll(async () => {
    fay = await person("fay-device@example.com");
    const pair = await pairing(fay);
    expect((await call("POST", "/api/vault/device-seals", { cookie: fay.cookie }, await sealBody(fay, pair))).statusCode).toBe(201);
    sealId = pair.deviceId;
  });

  it("chi non è full admin → 403, niente tolto", async () => {
    expect((await call("GET", `/api/vault/users/${fay.id}/device-seals`, { cookie: ada.cookie })).statusCode).toBe(403);
    expect((await call("DELETE", `/api/vault/users/${fay.id}/device-seals/${sealId}`, { cookie: ada.cookie })).statusCode).toBe(403);
    expect((await sealsOf(fay.id))[0]!.revokedAt).toBeNull();
  });

  it("il full admin senza riconferma recente → 403 `reauth_required`; un id di un'altra persona → 404", async () => {
    const stale = await call("DELETE", `/api/vault/users/${fay.id}/device-seals/${sealId}`, { cookie: await staleCookie(adminId) });
    expect([stale.statusCode, stale.json().code]).toEqual([403, "reauth_required"]);
    const [eveSeal] = await testDb.db.select().from(vaultDeviceSeals).where(eq(vaultDeviceSeals.revokedReason, "replaced"));
    expect((await call("DELETE", `/api/vault/users/${fay.id}/device-seals/${eveSeal!.id}`, { cookie: adminCookie })).statusCode).toBe(404);
  });

  it("il full admin elenca e toglie: il SOLO sigillo (`admin_removed`), registro con l'attore, avviso alla persona", async () => {
    const list = await call("GET", `/api/vault/users/${fay.id}/device-seals`, { cookie: adminCookie });
    expect((list.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([sealId]);
    const before = (await alerts(fay.id)).length;
    expect((await call("DELETE", `/api/vault/users/${fay.id}/device-seals/${sealId}`, { cookie: adminCookie })).statusCode).toBe(204);
    expect((await sealsOf(fay.id))[0]).toMatchObject({ revokedReason: "admin_removed" });
    const [ev] = await events(fay.id, "vault_device_seal_revoked");
    expect(ev!.actorUserId).toBe(adminId);
    expect((await alerts(fay.id)).length).toBe(before + 1);
    expect((await call("GET", "/api/auth/me", fay.desktop.headers)).statusCode).toBe(200);
  });
});
