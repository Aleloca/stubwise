import {
  PRF_INPUT,
  decryptPassword,
  encryptPassword,
  generatePersonKeyPair,
  keyFingerprint,
  sealPrivateKey,
  unwrapItemKey,
  wrapActorChallenge,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDLE_MS, MAX_OPEN_MS, REVEALS_PER_UNLOCK, STASH_MS, VaultCore, type CoreEvent } from "./core";
import { toBase64Url } from "./bytes";

// Il cuore della cassaforte nel browser, che gira nel Dedicated Worker
// (revisione di sicurezza I-1): la chiave di persona, la scadenza a ora di
// parete, la rete della cassaforte, Show. La pagina riceve solo esiti.

const CRED = "Y3JlZC0x";
const ME = "p-ada";
const TAG = "tag-1";
const C1 = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "11111111-1111-4111-8111-111111111111";

let clock: number;
let timers: { at: number; fn: () => void }[];
let calls: { method: string; path: string; body: unknown }[];
let routes: Record<string, () => { status?: number; body: unknown }>;
let events: CoreEvent[];
let prf: Uint8Array<ArrayBuffer>;
let serverTag: string | null | undefined;
let pair: Awaited<ReturnType<typeof generatePersonKeyPair>>;
/** La password di C1 cifrata, e la propria copia della sua chiave (per `KEY_ID`). */
let c1: { ciphertext: string; myCopy: string };

async function setup() {
  clock = Date.parse("2026-11-28T10:00:00Z");
  serverTag = "srv-tag-1";
  timers = [];
  calls = [];
  events = [];
  prf = crypto.getRandomValues(new Uint8Array(32));
  pair = await generatePersonKeyPair();
  const sealed = await sealPrivateKey(prf.slice().buffer, pair.privateKeyPkcs8, pair.publicKey);
  const { ciphertext, itemKey } = await encryptPassword(C1, "Kx4!pa-77Wq");
  const wrappedKey = await wrapItemKey(itemKey, pair.publicKey, C1, KEY_ID);
  c1 = { ciphertext, myCopy: wrappedKey };
  routes = {
    "GET /api/vault/status": () => ({
      body: {
        activated: true,
        myKey: { id: KEY_ID, status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" },
        seals: [{ passkeyId: "22222222-2222-4222-8222-222222222222", credentialIdB64url: CRED }],
        passkeys: [],
      },
    }),
    "POST /api/me/security/reauth/passkey/options": () => ({
      body: {
        challenge: "Y2hhbGxlbmdl",
        allowCredentials: [{ id: CRED, type: "public-key" }, { id: "b3RoZXI", type: "public-key" }],
        extensions: { prf: { eval: { first: toBase64Url(PRF_INPUT) } } },
      },
    }),
    "POST /api/me/security/reauth/passkey/verify": () => ({ body: {} }),
    "GET /api/vault/keys/mine": () => ({
      body: {
        id: KEY_ID,
        publicKey: pair.publicKey,
        status: "confirmed",
        seals: [{ passkeyId: "22222222-2222-4222-8222-222222222222", credentialIdB64url: CRED, sealedPrivateKey: sealed }],
      },
    }),
    [`POST /api/credentials/${C1}/reveal`]: () => ({ body: { passwordCiphertext: ciphertext, wrappedKey, personKeyId: KEY_ID } }),
    "GET /api/auth/me": () => ({ body: { user: { id: ME }, sessionTag: serverTag } }),
  };
  return new VaultCore({
    fetch: async (path, init) => {
      calls.push({ method: init.method!, path, body: init.body ? JSON.parse(init.body as string) : undefined });
      const route = routes[`${init.method} ${path}`];
      const out = route ? route() : { status: 404, body: { code: "not_found" } };
      const body = await out.body;
      return new Response(out.status === 204 ? null : JSON.stringify(body), { status: out.status ?? 200 });
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    emit: (e) => events.push(e),
  });
}

const assertion = { id: CRED, rawId: CRED, type: "public-key", response: {}, clientExtensionResults: {} };

async function openCore(core: VaultCore) {
  const p = await core.handle({ t: "prepare" });
  expect(p).toMatchObject({ ok: true, onlyCredentialIds: [CRED] });
  const buffer = prf.slice().buffer;
  await core.handle({ t: "stash", prf: buffer });
  return { buffer, out: await core.handle({ t: "unlock", assertion, credentialId: CRED, personId: ME, sessionTag: TAG }) };
}

describe("il cuore della cassaforte nel worker", () => {
  let core: VaultCore;
  beforeEach(async () => {
    core = await setup();
  });

  it("prepare: solo le passkey col sigillo; M-1 il salt PRF del server deve essere quello locale", async () => {
    expect(await core.handle({ t: "prepare" })).toMatchObject({ ok: true, onlyCredentialIds: [CRED] });
    routes["POST /api/me/security/reauth/passkey/options"] = () => ({
      body: { challenge: "x", allowCredentials: [{ id: CRED, type: "public-key" }], extensions: { prf: { eval: { first: "c3R1Yndpc2U" } } } },
    });
    expect(await core.handle({ t: "prepare" })).toEqual({ ok: false, code: "prf_mismatch" });
  });

  it("unlock: verifica, apre col sigillo, e la PRF si azzera; alla pagina solo l'esito", async () => {
    const { buffer, out } = await openCore(core);
    expect(out).toEqual({ ok: true });
    expect(new Uint8Array(buffer).every((b) => b === 0)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /api/me/security/reauth/passkey/verify");
    expect(JSON.stringify(calls)).not.toContain(toBase64Url(prf).slice(0, 10));
    expect(events.at(-1)).toMatchObject({ t: "state", state: "open" });
  });

  it("reveal: la sola password, con l'azione; con un'altra sessione o persona chiude", async () => {
    await openCore(core);
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toEqual({
      ok: true,
      password: "Kx4!pa-77Wq",
    });
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: "tag-2" })).toEqual({
      ok: false,
      code: "vault_locked",
    });
    expect(events.at(-1)).toMatchObject({ t: "state", state: "locked", reason: "session" });
  });

  it("I-3: un'altra sessione sul server (logout e login in un'altra scheda) chiude al primo Show", async () => {
    await openCore(core);
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toMatchObject({ ok: true });
    serverTag = "srv-tag-2";
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toEqual({
      ok: false,
      code: "vault_locked",
    });
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "session" });
    expect(calls.filter((c) => c.path.endsWith("/reveal"))).toHaveLength(1);
  });

  it("I-3: un server di prima senza `sessionTag` vale l'etichetta della pagina", async () => {
    serverTag = undefined;
    await openCore(core);
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toMatchObject({ ok: true });
  });

  it("15 minuti a ora di parete: al primo uso dopo, chiusa (nessun timer scattato)", async () => {
    await openCore(core);
    clock += IDLE_MS + 1;
    expect(await core.handle({ t: "reveal", id: C1, action: "copy", personId: ME, sessionTag: TAG })).toEqual({
      ok: false,
      code: "vault_locked",
    });
  });

  it("touch allunga la vita; il timer chiude una pagina in primo piano", async () => {
    await openCore(core);
    clock += IDLE_MS - 1000;
    await core.handle({ t: "touch" });
    clock += IDLE_MS - 1000;
    expect(await core.handle({ t: "status" })).toMatchObject({ state: "open" });
    clock += 2000;
    for (const t of [...timers]) if (t.at <= clock) t.fn();
    expect(await core.handle({ t: "status" })).toEqual({ state: "locked" });
  });

  it("m-1: 60 minuti dallo sblocco e chiude, qualunque touch arrivi; `closesAt` non va oltre", async () => {
    await openCore(core);
    const opened = clock;
    for (let i = 0; i < 6; i++) {
      clock += 10 * 60_000;
      await core.handle({ t: "touch" });
    }
    expect(await core.handle({ t: "status" })).toEqual({ state: "open", closesAt: opened + MAX_OPEN_MS });
    clock = opened + MAX_OPEN_MS + 1;
    await core.handle({ t: "touch" });
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    expect(events.at(-1)).toMatchObject({ t: "state", state: "locked", reason: "expired" });
  });

  it("m-1: il timer chiude anche alla scadenza assoluta, senza un uso", async () => {
    await openCore(core);
    const opened = clock;
    for (let i = 0; i < 5; i++) {
      clock += 12 * 60_000;
      await core.handle({ t: "touch" });
    }
    clock = opened + MAX_OPEN_MS + 2;
    for (const t of [...timers]) if (t.at <= clock) t.fn();
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "expired" });
  });

  it("m-1: dopo il tetto di reveal per sblocco si richiude e vuole di nuovo la passkey", async () => {
    await openCore(core);
    for (let i = 0; i < REVEALS_PER_UNLOCK; i++) {
      expect(await core.handle({ t: "reveal", id: C1, action: "copy", personId: ME, sessionTag: TAG })).toMatchObject({ ok: true });
    }
    expect(await core.handle({ t: "reveal", id: C1, action: "copy", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "reveal_limit" });
    const reveals = calls.filter((c) => c.path.endsWith("/reveal")).length;
    expect(reveals).toBe(REVEALS_PER_UNLOCK);
    await openCore(core);
    expect(await core.handle({ t: "reveal", id: C1, action: "copy", personId: ME, sessionTag: TAG })).toMatchObject({ ok: true });
  });

  it("m-3: alla chiusura il server azzera lo sblocco (best-effort); non per una sessione finita o cambiata, né per un'altra scheda", async () => {
    routes["POST /api/vault/lock"] = () => ({ status: 204, body: null });
    const lockCalls = () => calls.filter((c) => c.method === "POST" && c.path === "/api/vault/lock").length;
    await openCore(core);
    core.lock("user");
    await new Promise((r) => setTimeout(r, 0));
    expect(lockCalls()).toBe(1);
    core.lock("user");
    expect(lockCalls()).toBe(1);
    for (const reason of ["session", "remote", "logout"] as const) {
      await openCore(core);
      core.lock(reason);
      await new Promise((r) => setTimeout(r, 0));
      expect(lockCalls(), reason).toBe(1);
    }
    await openCore(core);
    routes["POST /api/vault/lock"] = () => ({ status: 500, body: { code: "boom" } });
    core.lock("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(lockCalls()).toBe(2);
    expect(await core.handle({ t: "status" })).toEqual({ state: "locked" });
  });

  it("I-2: un 401 su una rotta della cassaforte chiude con `session`", async () => {
    await openCore(core);
    routes[`POST /api/credentials/${C1}/reveal`] = () => ({ status: 401, body: { code: "unauthenticated" } });
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toMatchObject({ ok: false });
    expect(await core.handle({ t: "status" })).toEqual({ state: "locked" });
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "session" });
  });

  it("M-5: un `reauth_required` del server chiude la chiave, col suo motivo", async () => {
    await openCore(core);
    routes[`POST /api/credentials/${C1}/reveal`] = () => ({ status: 403, body: { code: "reauth_required" } });
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toEqual({
      ok: false,
      code: "reauth_required",
    });
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "reauth" });
  });

  it("`vault_unlock_required` (una rotta che vuole uno sblocco recente) chiude come `reauth`", async () => {
    await openCore(core);
    routes[`POST /api/credentials/${C1}/reveal`] = () => ({ status: 403, body: { code: "vault_unlock_required" } });
    expect(await core.handle({ t: "reveal", id: C1, action: "show", personId: ME, sessionTag: TAG })).toEqual({
      ok: false,
      code: "vault_unlock_required",
    });
    expect(events.at(-1)).toMatchObject({ state: "locked", reason: "reauth", code: "vault_unlock_required" });
  });

  it("una passkey d'altri (la PRF sbagliata): `open_failed`, chiusa, e la PRF azzerata", async () => {
    await core.handle({ t: "prepare" });
    const wrong = crypto.getRandomValues(new Uint8Array(32)).buffer;
    await core.handle({ t: "stash", prf: wrong });
    expect(
      await core.handle({ t: "unlock", assertion, credentialId: CRED, personId: ME, sessionTag: TAG }),
    ).toEqual({ ok: false, code: "open_failed" });
    expect(new Uint8Array(wrong).every((b) => b === 0)).toBe(true);
    expect(await core.handle({ t: "status" })).toEqual({ state: "locked" });
  });

  const unlockOnly = () => core.handle({ t: "unlock", assertion, credentialId: CRED, personId: ME, sessionTag: TAG });
  const zeroed = (b: ArrayBuffer) => new Uint8Array(b).every((x) => x === 0);

  it("I-A: senza una PRF ricevuta lo sblocco non parte (`no_prf`), nemmeno la verifica; la PRF si usa UNA volta", async () => {
    await core.handle({ t: "prepare" });
    expect(await unlockOnly()).toEqual({ ok: false, code: "no_prf" });
    expect(calls.some((c) => c.path.endsWith("/passkey/verify"))).toBe(false);
    const { out } = await openCore(core);
    expect(out).toEqual({ ok: true });
    core.lock("user");
    expect(await unlockOnly()).toEqual({ ok: false, code: "no_prf" });
  });

  it("I-A: la PRF ricevuta scade, una nuova sostituisce (e azzera) la vecchia, `discard` e la chiusura la azzerano", async () => {
    const a = prf.slice().buffer;
    await core.handle({ t: "stash", prf: a });
    clock += STASH_MS + 1;
    expect(await unlockOnly()).toEqual({ ok: false, code: "no_prf" });
    expect(zeroed(a)).toBe(true);
    const b = prf.slice().buffer;
    const c = prf.slice().buffer;
    await core.handle({ t: "stash", prf: b });
    await core.handle({ t: "stash", prf: c });
    expect(zeroed(b)).toBe(true);
    await core.handle({ t: "discard" });
    expect(zeroed(c)).toBe(true);
    const d = prf.slice().buffer;
    await core.handle({ t: "stash", prf: d });
    core.lock("pagehide");
    expect(zeroed(d)).toBe(true);
  });
});

const PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_KEY = "55555555-5555-4555-8555-555555555555";
const OTHER_USER = "66666666-6666-4666-8666-666666666666";

/** La password che una copia per `KEY_ID` apre, con la privata vera. */
async function openedBy(credentialId: string, body: { passwordCiphertext: string; copies: { recipientId: string; wrappedKey: string }[] }) {
  const copy = body.copies.find((c) => c.recipientId === KEY_ID)!;
  const privateKey = await crypto.subtle.importKey("pkcs8", pair.privateKeyPkcs8.slice(), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const itemKey = await unwrapItemKey(copy.wrappedKey, privateKey, credentialId, KEY_ID);
  return decryptPassword(credentialId, body.passwordCiphertext, itemKey);
}

describe("crea e cambia la password, nel worker", () => {
  let core: VaultCore;
  let other: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  let recovery: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  const recipients = () => ({
    people: [{ userId: "77777777-7777-4777-8777-777777777777", email: "ada@example.com", personKeyId: KEY_ID, publicKey: pair.publicKey }],
    recoveryPublicKey: recovery.publicKey,
  });
  beforeEach(async () => {
    core = await setup();
    other = await generatePersonKeyPair();
    recovery = await generatePersonKeyPair();
    routes[`GET /api/projects/${PROJECT}/credentials/recipients`] = () => ({ body: recipients() });
    routes[`POST /api/projects/${PROJECT}/credentials`] = () => ({ status: 201, body: {} });
    routes[`GET /api/credentials/${C1}/recipients`] = () => ({ body: recipients() });
    routes[`PUT /api/credentials/${C1}/password`] = () => ({ body: {} });
  });

  const fields = { service: "Aruba", label: "Pannello", username: "ada", url: null, notes: null };

  it("crea: senza la cassaforte aperta, cifrata per ogni persona e per il recupero; alla pagina solo l'id", async () => {
    const out = (await core.handle({ t: "create", projectId: PROJECT, fields, password: "N3w!pass" })) as { ok: true; id: string; resaved: boolean };
    expect(out).toEqual({ ok: true, id: expect.any(String), resaved: false });
    const post = calls.find((c) => c.method === "POST" && c.path === `/api/projects/${PROJECT}/credentials`)!;
    const body = post.body as { id: string; service: string; passwordCiphertext: string; copies: { recipientId: string; wrappedKey: string }[]; recoveryPublicKey: string };
    expect(body.id).toBe(out.id);
    expect(body.service).toBe("Aruba");
    expect(body.copies.map((c) => c.recipientId)).toEqual([KEY_ID, "recovery"]);
    expect(body.recoveryPublicKey).toBe(recovery.publicKey);
    expect(JSON.stringify(body)).not.toContain("N3w!pass");
    expect(await openedBy(out.id, body)).toBe("N3w!pass");
  });

  it("crea: i campi dalla pagina non sovrascrivono l'id né il cifrato", async () => {
    const evil = { ...fields, id: "88888888-8888-4888-8888-888888888888", passwordCiphertext: "x", copies: [] };
    const out = (await core.handle({ t: "create", projectId: PROJECT, fields: evil, password: "N3w!pass" })) as { ok: true; id: string };
    const body = calls.find((c) => c.method === "POST" && c.path === `/api/projects/${PROJECT}/credentials`)!.body as never as { id: string; passwordCiphertext: string; copies: { recipientId: string; wrappedKey: string }[] };
    expect(body.id).toBe(out.id);
    expect(body.id).not.toBe(evil.id);
    expect(await openedBy(out.id, body)).toBe("N3w!pass");
  });

  it("crea: `recipients_changed` si rifà UNA volta per i destinatari attuali (resaved); la seconda volta si ferma", async () => {
    let posts = 0;
    routes[`POST /api/projects/${PROJECT}/credentials`] = () => {
      posts += 1;
      if (posts > 1) return { status: 201, body: {} };
      const now = recipients();
      now.people.push({ userId: OTHER_USER, email: "bea@example.com", personKeyId: OTHER_KEY, publicKey: other.publicKey });
      return { status: 409, body: { code: "recipients_changed", recipients: now } };
    };
    expect(await core.handle({ t: "create", projectId: PROJECT, fields, password: "N3w!pass" })).toMatchObject({ ok: true, resaved: true });
    const last = calls.filter((c) => c.method === "POST" && c.path === `/api/projects/${PROJECT}/credentials`).at(-1)!;
    expect((last.body as { copies: { recipientId: string }[] }).copies.map((c) => c.recipientId)).toEqual([KEY_ID, OTHER_KEY, "recovery"]);

    routes[`POST /api/projects/${PROJECT}/credentials`] = () => ({ status: 409, body: { code: "recipients_changed", recipients: recipients() } });
    expect(await core.handle({ t: "create", projectId: PROJECT, fields, password: "N3w!pass" })).toEqual({ ok: false, code: "recipients_changed" });
  });

  it("cambia: a cassaforte chiusa non scrive niente; aperta, la password nuova per i destinatari", async () => {
    expect(await core.handle({ t: "setPassword", id: C1, password: "Ch4nged!", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await openCore(core);
    expect(await core.handle({ t: "setPassword", id: C1, password: "Ch4nged!", personId: ME, sessionTag: TAG })).toEqual({ ok: true, resaved: false });
    const put = calls.find((c) => c.method === "PUT" && c.path === `/api/credentials/${C1}/password`)!;
    expect(await openedBy(C1, put.body as never)).toBe("Ch4nged!");
  });

  it("cambia: con un'altra sessione sul server chiude e non scrive", async () => {
    await openCore(core);
    serverTag = "srv-tag-2";
    expect(await core.handle({ t: "setPassword", id: C1, password: "Ch4nged!", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(events.at(-1)).toMatchObject({ t: "state", state: "locked", reason: "session" });
  });
});

/** Le sfide di possesso date dal server, in ordine: id e segreto atteso. */
let challenges: { challengeId: string; proof: string }[];

function serveChallenges() {
  challenges = [];
  routes["POST /api/vault/actor-challenge"] = () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const challengeId = crypto.randomUUID();
    challenges.push({ challengeId, proof: toBase64Url(secret) });
    // La busta si prepara qui sotto (asincrona): la rotta risponde con una promessa risolta.
    return { body: wrapActorChallenge(secret, pair.publicKey, challengeId, KEY_ID).then((wrapped) => ({ challengeId, personKeyId: KEY_ID, wrapped, expiresAt: "2026-11-28T10:05:00.000Z" })) };
  };
}

/** La password che apre la copia per `OTHER_KEY`, con la privata dell'altra persona. */
async function openedByOther(other: Awaited<ReturnType<typeof generatePersonKeyPair>>, wrappedKey: string) {
  const privateKey = await crypto.subtle.importKey("pkcs8", other.privateKeyPkcs8.slice(), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const itemKey = await unwrapItemKey(wrappedKey, privateKey, C1, OTHER_KEY);
  return decryptPassword(C1, c1.ciphertext, itemKey);
}

describe("condividi e togli un lettore, nel worker", () => {
  let core: VaultCore;
  let other: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  const preview = (keyVersion = "v1") => ({
    people: [{ userId: OTHER_USER, email: "bea@example.com", personKeyId: OTHER_KEY, publicKey: other.publicKey }],
    waiting: [{ userId: "99999999-9999-4999-8999-999999999999", email: "cleo@example.com" }],
    wrappedKey: c1.myCopy,
    keyVersion,
  });
  beforeEach(async () => {
    core = await setup();
    other = await generatePersonKeyPair();
    serveChallenges();
    routes[`GET /api/credentials/${C1}/readers/preview?userId=${OTHER_USER}`] = () => ({ body: preview() });
    routes[`POST /api/credentials/${C1}/readers`] = () => ({ status: 201, body: {} });
    routes[`DELETE /api/credentials/${C1}/readers/${OTHER_USER}`] = () => ({ status: 204, body: null });
  });

  const share = (sessionTag = TAG) => core.handle({ t: "share", id: C1, target: { userId: OTHER_USER }, personId: ME, sessionTag });

  it("condividi: a cassaforte chiusa niente; aperta, una copia che apre la password, la prova della sfida, chi aspetta", async () => {
    expect(await share()).toEqual({ ok: false, code: "vault_locked" });
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/readers"))).toBe(false);
    await openCore(core);
    expect(await share()).toEqual({ ok: true, waiting: ["cleo@example.com"] });
    const post = calls.find((c) => c.method === "POST" && c.path === `/api/credentials/${C1}/readers`)!;
    const body = post.body as { userId: string; copies: { recipientId: string; wrappedKey: string }[]; keyVersion: string; actorProof: { challengeId: string; proof: string } };
    expect(body.userId).toBe(OTHER_USER);
    expect(body.keyVersion).toBe("v1");
    expect(body.copies.map((c) => c.recipientId)).toEqual([OTHER_KEY]);
    expect(await openedByOther(other, body.copies[0]!.wrappedKey)).toBe("Kx4!pa-77Wq");
    expect(body.actorProof).toEqual(challenges[0]);
  });

  it("condividi: il bersaglio esce solo come `userId` o `roleId`, niente altro dalla pagina", async () => {
    await openCore(core);
    await core.handle({ t: "share", id: C1, target: { userId: OTHER_USER, extra: "x" } as never, personId: ME, sessionTag: TAG });
    const body = calls.find((c) => c.method === "POST" && c.path === `/api/credentials/${C1}/readers`)!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["actorProof", "copies", "keyVersion", "userId"]);
  });

  it("condividi: `recipients_changed` si rifà UNA volta sull'anteprima attuale, con una prova NUOVA", async () => {
    await openCore(core);
    let posts = 0;
    routes[`POST /api/credentials/${C1}/readers`] = () => {
      posts += 1;
      return posts === 1 ? { status: 409, body: { code: "recipients_changed", preview: preview("v2") } } : { status: 201, body: {} };
    };
    expect(await share()).toEqual({ ok: true, waiting: ["cleo@example.com"] });
    const posted = calls.filter((c) => c.method === "POST" && c.path === `/api/credentials/${C1}/readers`).map((c) => c.body as { keyVersion: string; actorProof: { challengeId: string } });
    expect(posted.map((b) => b.keyVersion)).toEqual(["v1", "v2"]);
    expect(posted[0]!.actorProof.challengeId).not.toBe(posted[1]!.actorProof.challengeId);
    routes[`POST /api/credentials/${C1}/readers`] = () => ({ status: 409, body: { code: "recipients_changed", preview: preview("v3") } });
    expect(await share()).toEqual({ ok: false, code: "recipients_changed" });
  });

  it("condividi: una sfida per un'altra chiave non dà la prova (`stale_key`)", async () => {
    await openCore(core);
    routes["POST /api/vault/actor-challenge"] = () => ({ body: { challengeId: crypto.randomUUID(), personKeyId: OTHER_KEY, wrapped: "x", expiresAt: "2026-11-28T10:05:00.000Z" } });
    expect(await share()).toEqual({ ok: false, code: "stale_key" });
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/credentials/${C1}/readers`)).toBe(false);
  });

  it("condividi: con un'altra sessione sul server chiude e non condivide", async () => {
    await openCore(core);
    serverTag = "srv-tag-2";
    expect(await share()).toEqual({ ok: false, code: "vault_locked" });
    expect(calls.some((c) => c.path.includes("/readers"))).toBe(false);
  });

  it("togli: con la prova, solo a cassaforte aperta", async () => {
    const remove = () => core.handle({ t: "removeReader", id: C1, readerId: OTHER_USER, personId: ME, sessionTag: TAG });
    expect(await remove()).toEqual({ ok: false, code: "vault_locked" });
    await openCore(core);
    expect(await remove()).toEqual({ ok: true });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe(`/api/credentials/${C1}/readers/${OTHER_USER}`);
    expect(del.body).toEqual({ actorProof: challenges[0] });
  });
});

describe("chi aspetta, conferma e rifiuta, nel worker", () => {
  let core: VaultCore;
  let bea: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  const C2 = "77777777-7777-4777-8777-777777777777";
  const PROJ = "88888888-8888-4888-8888-888888888888";
  const pendingBody = () => ({
    items: [
      {
        user: { id: OTHER_USER, email: "bea@example.com" },
        personKey: { id: OTHER_KEY, status: "pending", createdAt: "2026-11-20T10:00:00.000Z", device: "Safari", fingerprintSource: bea.publicKey },
        credentials: [
          { id: C1, projectId: PROJ, service: "Aruba", label: null, wrappedKey: c1.myCopy, keyVersion: "v1" },
          // Una copia che non si apre con la mia chiave: si salta.
          { id: C2, projectId: PROJ, service: "Fastweb", label: "Router", wrappedKey: c1.myCopy, keyVersion: "v9" },
        ],
      },
    ],
  });
  beforeEach(async () => {
    core = await setup();
    bea = await generatePersonKeyPair();
    serveChallenges();
    routes["GET /api/vault/pending"] = () => ({ body: pendingBody() });
    routes[`POST /api/vault/pending/${OTHER_KEY}/confirm`] = () => ({
      body: { personKeyId: OTHER_KEY, status: "confirmed", saved: [C1], skipped: [] },
    });
    routes[`POST /api/vault/pending/${OTHER_KEY}/reject`] = () => ({ status: 204, body: null });
  });

  it("chi aspetta: anche a cassaforte chiusa, con l'impronta e senza le copie", async () => {
    const out = (await core.handle({ t: "pending" })) as { ok: true; items: Record<string, unknown>[] };
    expect(out.ok).toBe(true);
    expect(out.items).toEqual([
      {
        userId: OTHER_USER,
        email: "bea@example.com",
        personKeyId: OTHER_KEY,
        status: "pending",
        createdAt: "2026-11-20T10:00:00.000Z",
        device: "Safari",
        fingerprint: await keyFingerprint(bea.publicKey),
        credentials: [
          { id: C1, projectId: PROJ, service: "Aruba", label: null },
          { id: C2, projectId: PROJ, service: "Fastweb", label: "Router" },
        ],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain(c1.myCopy.slice(0, 20));
  });

  it("conferma: chiusa niente; aperta, ricifra per la chiave della persona le copie che si aprono, con la prova; l'esito in conteggi", async () => {
    expect(await core.handle({ t: "confirm", keyId: OTHER_KEY, personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    await openCore(core);
    expect(await core.handle({ t: "confirm", keyId: OTHER_KEY, personId: ME, sessionTag: TAG })).toEqual({
      ok: true,
      saved: 1,
      keyChanged: 0,
      notAllowed: 0,
      unopenable: 1,
    });
    const post = calls.find((c) => c.path === `/api/vault/pending/${OTHER_KEY}/confirm`)!;
    const body = post.body as { copies: { credentialId: string; wrappedKey: string; keyVersion: string }[]; actorProof: unknown };
    expect(body.copies.map((c) => [c.credentialId, c.keyVersion])).toEqual([[C1, "v1"]]);
    const privateKey = await crypto.subtle.importKey("pkcs8", bea.privateKeyPkcs8.slice(), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const itemKey = await unwrapItemKey(body.copies[0]!.wrappedKey, privateKey, C1, OTHER_KEY);
    expect(await decryptPassword(C1, c1.ciphertext, itemKey)).toBe("Kx4!pa-77Wq");
    expect(body.actorProof).toEqual(challenges[0]);
  });

  it("conferma: i rifiuti del server diventano conteggi; una persona che non aspetta più è `not_pending`, senza prova", async () => {
    await openCore(core);
    routes[`POST /api/vault/pending/${OTHER_KEY}/confirm`] = () => ({
      body: { personKeyId: OTHER_KEY, status: "pending", saved: [], skipped: [{ credentialId: C1, reason: "key_changed" }, { credentialId: C2, reason: "not_allowed" }] },
    });
    expect(await core.handle({ t: "confirm", keyId: OTHER_KEY, personId: ME, sessionTag: TAG })).toMatchObject({ ok: true, saved: 0, keyChanged: 1, notAllowed: 1 });
    routes["GET /api/vault/pending"] = () => ({ body: { items: [] } });
    const before = challenges.length;
    expect(await core.handle({ t: "confirm", keyId: OTHER_KEY, personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "not_pending" });
    expect(challenges.length).toBe(before);
  });

  it("rifiuta: con la prova, solo a cassaforte aperta e con la sessione dell'apertura", async () => {
    const reject = () => core.handle({ t: "reject", keyId: OTHER_KEY, personId: ME, sessionTag: TAG });
    expect(await reject()).toEqual({ ok: false, code: "vault_locked" });
    await openCore(core);
    expect(await reject()).toEqual({ ok: true });
    expect(calls.find((c) => c.path === `/api/vault/pending/${OTHER_KEY}/reject`)!.body).toEqual({ actorProof: challenges[0] });
    serverTag = "srv-tag-2";
    expect(await reject()).toEqual({ ok: false, code: "vault_locked" });
  });
});

