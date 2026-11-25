import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
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

  it("un PAT `manual` o `mobile` non elenca né toglie: 403 `session_required` (il desktop col sigillo sì: sotto)", async () => {
    const [row] = await sealsOf(ada.id);
    for (const kind of ["manual", "mobile"] as const) {
      const headers = (await pat(ada.id, kind)).headers;
      expect((await call("GET", "/api/vault/device-seals", headers)).json().code, kind).toBe("session_required");
      expect((await call("DELETE", `/api/vault/device-seals/${row!.id}`, headers)).json().code, kind).toBe("session_required");
    }
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

describe("il PAT desktop col sigillo sulle rotte della cassaforte (D-7)", () => {
  let gus: Person;
  let credentialId: string;
  let projectId: string;
  /** Una seconda persona con una chiave IN ATTESA: gus la può rifiutare (è full admin). */
  let pendingKeyId: string;
  /** Il secondo Mac di gus (PAT desktop col suo sigillo). */
  let second: { id: string; headers: { authorization: string } };

  async function asFullAdmin(p: Person): Promise<void> {
    const { users } = await import("@stubwise/db");
    const [admin] = await testDb.db.select({ instanceRoleId: users.instanceRoleId }).from(users).where(eq(users.id, adminId));
    await testDb.db.update(users).set({ instanceRoleId: admin!.instanceRoleId }).where(eq(users.id, p.id));
  }

  async function sealed(p: Person): Promise<string> {
    const pair = await pairing(p);
    const res = await call("POST", "/api/vault/device-seals", { cookie: p.cookie }, await sealBody(p, pair));
    expect(res.statusCode, res.body).toBe(201);
    return pair.deviceId;
  }

  /** La sfida e la prova chieste da `headers` (sessione o PAT desktop). */
  async function proofFrom(p: Person, headers: Record<string, string>) {
    const res = await call("POST", "/api/vault/actor-challenge", headers);
    expect(res.statusCode, res.body).toBe(201);
    const { challengeId, wrapped, personKeyId } = res.json() as { challengeId: string; wrapped: string; personKeyId: string };
    return { challengeId, proof: await openActorChallenge(wrapped, p.privateKey, challengeId, personKeyId) };
  }

  beforeAll(async () => {
    const { credentialKeyCopies, credentials, projects } = await import("@stubwise/db");
    gus = await person("gus-device@example.com");
    await asFullAdmin(gus);
    gus.cookie = await fullSessionCookie(app, gus.id);
    const [project] = await testDb.db
      .insert(projects)
      .values({ name: "Mac", slug: "mac-vault", ingestionKey: "mac-vault-key" })
      .returning({ id: projects.id });
    projectId = project!.id;
    credentialId = randomUUID();
    await testDb.db.insert(credentials).values({ id: credentialId, projectId, service: "Servizio", passwordCiphertext: '{"v":1,"x":"cifrata"}' });
    await testDb.db.insert(credentialKeyCopies).values({ credentialId, recipientId: gus.keyId, wrappedKey: '{"v":1,"x":"copia"}' });
    const hal = await createUserWithSession(app, "hal-device@example.com");
    const [pending] = await testDb.db
      .insert(vaultPersonKeys)
      .values({ userId: hal.id, publicKey: publicJwk(), status: "pending" })
      .returning({ id: vaultPersonKeys.id });
    pendingKeyId = pending!.id;
  });

  const reveal = (headers: Record<string, string>) => call("POST", `/api/credentials/${credentialId}/reveal`, headers, { action: "show" });

  it("un PAT `manual` o `mobile` resta fuori: 403 `session_required` su reveal, sfida e accessi in attesa", async () => {
    for (const kind of ["manual", "mobile"] as const) {
      const headers = (await pat(gus.id, kind)).headers;
      for (const res of [await reveal(headers), await call("POST", "/api/vault/actor-challenge", headers), await call("GET", "/api/vault/pending", headers)]) {
        expect([res.statusCode, res.json().code], kind).toEqual([403, "session_required"]);
      }
    }
  });

  it("il PAT desktop SENZA sigillo → 403 `device_seal_required` (il desktop propone di associare); nessuna riga nel registro degli accessi", async () => {
    const { credentialAccessLog } = await import("@stubwise/db");
    for (const res of [await reveal(gus.desktop.headers), await call("POST", "/api/vault/actor-challenge", gus.desktop.headers), await call("GET", "/api/vault/pending", gus.desktop.headers)]) {
      expect([res.statusCode, res.json().code]).toEqual([403, "device_seal_required"]);
    }
    expect(await testDb.db.select().from(credentialAccessLog).where(eq(credentialAccessLog.credentialId, credentialId))).toHaveLength(0);
  });

  it("col sigillo vivo: reveal dal Mac, e il registro degli accessi dice `desktop` e quale Mac; dal browser dice `browser`", async () => {
    const { credentialAccessLog } = await import("@stubwise/db");
    const sealId = await sealed(gus);
    const res = await reveal(gus.desktop.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ passwordCiphertext: '{"v":1,"x":"cifrata"}', wrappedKey: '{"v":1,"x":"copia"}', personKeyId: gus.keyId });
    expect((await reveal({ cookie: gus.cookie })).statusCode).toBe(200);
    const rows = await testDb.db.select().from(credentialAccessLog).where(eq(credentialAccessLog.credentialId, credentialId));
    expect(rows.map((r) => [r.via, r.deviceSealId]).sort()).toEqual([["browser", null], ["desktop", sealId]]);
    const log = await call("GET", `/api/projects/${projectId}/credentials/log`, { cookie: gus.cookie });
    expect((log.json() as { items: { via: string }[] }).items.map((i) => i.via).sort()).toEqual(["browser", "desktop"]);
  });

  it("le rotte di ultima istanza restano del browser anche col sigillo vivo: 403 `session_required`, niente scritto", async () => {
    const before = await testDb.db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.userId, gus.id));
    const cases: [string, string, unknown?][] = [
      ["GET", "/api/vault/status"],
      ["GET", "/api/vault/keys/mine"],
      ["POST", "/api/vault/keys", { publicKey: publicJwk(), seals: [{ passkeyId: randomUUID(), sealedPrivateKey: '{"v":1}' }], device: "Mac" }],
      ["POST", "/api/vault/activate", { recoveryPublicKey: publicJwk() }],
      ["GET", "/api/vault/recovery-key/preview"],
      ["POST", "/api/vault/recovery/challenge"],
      ["POST", "/api/vault/device-pairings/lookup", { state: "x" }],
    ];
    for (const [method, url, body] of cases) {
      const res = await call(method as "GET" | "POST", url, gus.desktop.headers, body);
      expect([res.statusCode, res.json().code], `${method} ${url}`).toEqual([403, "session_required"]);
    }
    expect(await testDb.db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.userId, gus.id))).toEqual(before);
  });

  it("la sfida chiesta dal Mac è legata al SUO PAT: non vale dal browser né da un altro PAT desktop, e viceversa", async () => {
    const fromMac = await proofFrom(gus, gus.desktop.headers);
    const byBrowser = await call("POST", `/api/vault/pending/${pendingKeyId}/reject`, { cookie: gus.cookie }, { actorProof: fromMac });
    expect([byBrowser.statusCode, byBrowser.json().code]).toEqual([403, "vault_proof_invalid"]);
    const fromBrowser = await proofFrom(gus, { cookie: gus.cookie });
    const byMac = await call("POST", `/api/vault/pending/${pendingKeyId}/reject`, gus.desktop.headers, { actorProof: fromBrowser });
    expect([byMac.statusCode, byMac.json().code]).toEqual([403, "vault_proof_invalid"]);
    // Un secondo Mac della stessa persona, col suo sigillo: la sfida del primo non vale.
    second = await pat(gus.id, "desktop");
    const g2 = { ...gus, desktop: second };
    await sealed(g2);
    const fromFirst = await proofFrom(gus, gus.desktop.headers);
    const bySecond = await call("POST", `/api/vault/pending/${pendingKeyId}/reject`, second.headers, { actorProof: fromFirst });
    expect([bySecond.statusCode, bySecond.json().code]).toEqual([403, "vault_proof_invalid"]);
    const [key] = await testDb.db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.id, pendingKeyId));
    expect(key!.status).toBe("pending");
  });

  it("col sigillo vivo e la prova del Mac, il Mac rifiuta una chiave in attesa (come il browser)", async () => {
    const proof = await proofFrom(gus, gus.desktop.headers);
    const res = await call("POST", `/api/vault/pending/${pendingKeyId}/reject`, gus.desktop.headers, { actorProof: proof });
    expect(res.statusCode, res.body).toBe(204);
    const [key] = await testDb.db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.id, pendingKeyId));
    expect(key!.status).toBe("rejected");
  });

  it("col sigillo vivo il Mac vede i lettori della credenziale (le rotte dei lettori passano dal gate)", async () => {
    const res = await call("GET", `/api/credentials/${credentialId}/readers`, gus.desktop.headers);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("revoca a LETTURA: sigillo tolto dal browser, o chiave di persona ricreata → 403 `device_seal_required` SUBITO", async () => {
    const { credentialAccessLog } = await import("@stubwise/db");
    const [live] = await testDb.db
      .select()
      .from(vaultDeviceSeals)
      .where(and(eq(vaultDeviceSeals.patId, gus.desktop.id), isNull(vaultDeviceSeals.revokedAt)));
    expect((await call("DELETE", `/api/vault/device-seals/${live!.id}`, { cookie: gus.cookie })).statusCode).toBe(204);
    const count = async () => (await testDb.db.select().from(credentialAccessLog).where(eq(credentialAccessLog.credentialId, credentialId))).length;
    const before = await count();
    const removed = await reveal(gus.desktop.headers);
    expect([removed.statusCode, removed.json().code]).toEqual([403, "device_seal_required"]);
    // Il secondo Mac di gus ha ancora il sigillo e legge; la chiave ricreata
    // lo spegne SUBITO, con la riga del sigillo ancora viva.
    expect((await reveal(second.headers)).statusCode).toBe(200);
    const after = await count();
    await testDb.db.update(vaultPersonKeys).set({ status: "superseded" }).where(eq(vaultPersonKeys.id, gus.keyId));
    await testDb.db.insert(vaultPersonKeys).values({ userId: gus.id, publicKey: publicJwk(), status: "confirmed", confirmedAt: new Date() });
    const recreated = await reveal(second.headers);
    expect([recreated.statusCode, recreated.json().code]).toEqual([403, "device_seal_required"]);
    const [stillLive] = await testDb.db
      .select()
      .from(vaultDeviceSeals)
      .where(and(eq(vaultDeviceSeals.patId, second.id), isNull(vaultDeviceSeals.revokedAt)));
    expect(stillLive).toBeDefined();
    expect(after).toBe(before + 1);
    expect(await count()).toBe(after);
  });
});

describe("il gate (`vaultCallerOf`): la dichiarazione della rotta conta", () => {
  it("col sigillo vivo il PAT desktop passa SOLO dove la rotta dichiara `desktopVault`; altrove `session_required`", async () => {
    const { vaultCallerOf } = await import("../vault/device-access.js");
    const ivy = await person("ivy-device@example.com");
    const pair = await pairing(ivy);
    expect((await call("POST", "/api/vault/device-seals", { cookie: ivy.cookie }, await sealBody(ivy, pair))).statusCode).toBe(201);
    const user = { id: ivy.id, email: "ivy-device@example.com", patId: ivy.desktop.id, patKind: "desktop" };
    const request = (config: Record<string, unknown>) => ({ user, routeOptions: { config } }) as never;
    expect(await vaultCallerOf(testDb.db, request({ desktopVault: true }))).toEqual({ ok: true, caller: { via: "desktop", sealId: pair.deviceId } });
    expect(await vaultCallerOf(testDb.db, request({}))).toEqual({ ok: false, code: "session_required" });
    expect(await vaultCallerOf(testDb.db, request({ desktopVault: true, browserOnly: true }))).toMatchObject({ ok: true });
  });
});

describe("togliere un ALTRO proprio Mac dal desktop (decisione del maintainer, 25 nov 2026)", () => {
  let jo: Person;
  /** Il secondo Mac di jo, da togliere dal primo. */
  let other: { id: string; headers: { authorization: string } };
  let otherSealId: string;

  const fresh = (patId: string, at: Date | null = new Date()) =>
    testDb.db.update(personalAccessTokens).set({ secondFactorAt: at }).where(eq(personalAccessTokens.id, patId));

  async function sealedFor(p: Person, desktop: { id: string; headers: { authorization: string } }) {
    const pair = await pairing({ ...p, desktop });
    const res = await call("POST", "/api/vault/device-seals", { cookie: p.cookie }, await sealBody(p, pair));
    expect(res.statusCode, res.body).toBe(201);
    return pair.deviceId;
  }

  beforeAll(async () => {
    jo = await person("jo-device@example.com");
    await sealedFor(jo, jo.desktop);
    other = await pat(jo.id, "desktop");
    otherSealId = await sealedFor(jo, other);
  });

  const remove = (id: string, headers: Record<string, string>, body?: unknown) => call("DELETE", `/api/vault/device-seals/${id}`, headers, body);

  /** La prova della propria chiave chiesta dal Mac (`headers`) o dal browser. */
  async function proof(headers: Record<string, string>) {
    const res = await call("POST", "/api/vault/actor-challenge", headers);
    expect(res.statusCode, res.body).toBe(201);
    const { challengeId, wrapped, personKeyId } = res.json() as { challengeId: string; wrapped: string; personKeyId: string };
    return { challengeId, proof: await openActorChallenge(wrapped, jo.privateKey, challengeId, personKeyId) };
  }

  it("un PAT `manual` → 403 `session_required`, niente tolto", async () => {
    const manual = await pat(jo.id, "manual");
    const res = await remove(otherSealId, manual.headers);
    expect([res.statusCode, res.json().code]).toEqual([403, "session_required"]);
    expect((await sealsOf(jo.id)).find((s) => s.id === otherSealId)!.revokedAt).toBeNull();
  });

  it("senza la riconferma del desktop → 403 `reauth_required`, niente tolto", async () => {
    await fresh(jo.desktop.id, null);
    const res = await remove(otherSealId, jo.desktop.headers);
    expect([res.statusCode, res.json().code]).toEqual([403, "reauth_required"]);
    expect((await sealsOf(jo.id)).find((s) => s.id === otherSealId)!.revokedAt).toBeNull();
  });

  it("un PAT desktop riconfermato ma SENZA sigillo vivo → 403 `device_seal_required`, niente tolto", async () => {
    const bare = await pat(jo.id, "desktop");
    await fresh(bare.id);
    const res = await remove(otherSealId, bare.headers);
    expect([res.statusCode, res.json().code]).toEqual([403, "device_seal_required"]);
    expect((await sealsOf(jo.id)).find((s) => s.id === otherSealId)!.revokedAt).toBeNull();
  });

  it("l'elenco dal Mac (col sigillo vivo): i propri Mac vivi, `current` vero SOLO per il suo; dal browser `current` è falso", async () => {
    const mine = (await call("GET", "/api/vault/device-seals/mine", jo.desktop.headers)).json() as { id: string };
    const res = await call("GET", "/api/vault/device-seals", jo.desktop.headers);
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: { id: string; current: boolean }[] }).items;
    expect(items.map((i) => [i.id, i.current]).sort()).toEqual([[mine.id, true], [otherSealId, false]].sort());
    const browser = (await call("GET", "/api/vault/device-seals", { cookie: jo.cookie })).json() as { items: { current: boolean }[] };
    expect(browser.items.every((i) => i.current === false)).toBe(true);
  });

  it("il sigillo del Mac che chiama, per id → 409 `use_mine` (per quello c'è DELETE .../mine), intatto", async () => {
    await fresh(jo.desktop.id);
    const mine = (await call("GET", "/api/vault/device-seals/mine", jo.desktop.headers)).json() as { id: string };
    const res = await remove(mine.id, jo.desktop.headers);
    expect([res.statusCode, res.json().code]).toEqual([409, "use_mine"]);
    expect((await sealsOf(jo.id)).find((s) => s.id === mine.id)!.revokedAt).toBeNull();
  });

  it("dal Mac, con la riconferma ma SENZA la prova della propria chiave (o con quella del browser) → 403 `vault_proof_invalid`, niente tolto (decisione di 46, 25 nov 2026)", async () => {
    await fresh(jo.desktop.id);
    const none = await remove(otherSealId, jo.desktop.headers);
    expect([none.statusCode, none.json().code]).toEqual([403, "vault_proof_invalid"]);
    const browserProof = await proof({ cookie: jo.cookie });
    const wrong = await remove(otherSealId, jo.desktop.headers, { actorProof: browserProof });
    expect([wrong.statusCode, wrong.json().code]).toEqual([403, "vault_proof_invalid"]);
    expect((await sealsOf(jo.id)).find((s) => s.id === otherSealId)!.revokedAt).toBeNull();
    expect(await events(jo.id, "vault_device_seal_revoked")).toHaveLength(0);
  });

  it("il Mac di un'ALTRA persona → 404, intatto", async () => {
    const kim = await person("kim-device@example.com");
    const kimSeal = await sealedFor(kim, kim.desktop);
    await fresh(jo.desktop.id);
    expect((await remove(kimSeal, jo.desktop.headers, { actorProof: await proof(jo.desktop.headers) })).statusCode).toBe(404);
    expect((await sealsOf(kim.id))[0]!.revokedAt).toBeNull();
  });

  it("col sigillo vivo e la riconferma, il Mac toglie l'ALTRO Mac della persona: il solo sigillo, registro e avviso; l'altro Mac resta collegato", async () => {
    await fresh(jo.desktop.id);
    const before = (await alerts(jo.id)).length;
    expect((await remove(otherSealId, jo.desktop.headers, { actorProof: await proof(jo.desktop.headers) })).statusCode).toBe(204);
    expect((await sealsOf(jo.id)).find((s) => s.id === otherSealId)).toMatchObject({ revokedReason: "removed" });
    expect(await events(jo.id, "vault_device_seal_revoked")).toHaveLength(1);
    expect((await alerts(jo.id)).length).toBe(before + 1);
    expect((await call("GET", "/api/auth/me", other.headers)).statusCode).toBe(200);
    expect((await call("GET", "/api/vault/device-seals/mine", other.headers)).statusCode).toBe(404);
    // Il Mac che ha tolto l'altro tiene il suo sigillo.
    expect((await call("GET", "/api/vault/device-seals/mine", jo.desktop.headers)).statusCode).toBe(200);
  });
});
