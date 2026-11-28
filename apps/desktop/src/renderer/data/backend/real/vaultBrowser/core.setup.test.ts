import {
  PRF_INPUT,
  decryptPassword,
  encryptPassword,
  generatePersonKeyPair,
  generateRecoveryKit,
  openPrivateKey,
  parseRecoveryKit,
  sealPrivateKey,
  unwrapItemKey,
  wrapActorChallenge,
  wrapItemKey,
  wrapRecoveryChallenge,
} from "@stubwise/vault-crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultCore, type CoreEvent } from "./core";
import { toBase64Url } from "./bytes";

// La fase 2 della cassaforte nel browser (design §10, I7): quello che serve
// per ritirare il web vecchio. Qui la propria chiave: crearla (prima volta,
// o di nuovo quando nessuna passkey la apre più). Tutto nel worker, come lo
// sblocco: la coppia nasce qui, la privata si sigilla con la PRF e la pagina
// riceve solo l'esito.

const CRED = "Y3JlZC0x";
const OTHER_CRED = "b3RoZXI";
const ME = "p-ada";
const TAG = "tag-1";
const PASSKEY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PASSKEY_ID = "44444444-4444-4444-8444-444444444444";
const NEW_KEY = "55555555-5555-4555-8555-555555555555";

let clock: number;
let calls: { method: string; path: string; body: unknown }[];
let routes: Record<string, () => { status?: number; body: unknown }>;
let events: CoreEvent[];
let prf: Uint8Array<ArrayBuffer>;
let myKey: { id: string; status: string; createdAt: string } | null;
let activated: boolean;

function setup() {
  clock = Date.parse("2026-11-28T10:00:00Z");
  calls = [];
  events = [];
  prf = crypto.getRandomValues(new Uint8Array(32));
  myKey = null;
  activated = true;
  routes = {
    "GET /api/vault/status": () => ({
      body: {
        activated,
        myKey,
        seals: [],
        passkeys: [
          { passkeyId: PASSKEY_ID, credentialIdB64url: CRED },
          { passkeyId: OTHER_PASSKEY_ID, credentialIdB64url: OTHER_CRED },
        ],
      },
    }),
    "POST /api/me/security/reauth/passkey/options": () => ({
      body: {
        challenge: "Y2hhbGxlbmdl",
        allowCredentials: [{ id: CRED, type: "public-key" }, { id: OTHER_CRED, type: "public-key" }],
        extensions: { prf: { eval: { first: toBase64Url(PRF_INPUT) } } },
      },
    }),
    "POST /api/me/security/reauth/passkey/verify": () => ({ status: 204, body: null }),
    "GET /api/auth/me": () => ({ body: { user: { id: ME }, sessionTag: "srv-tag" } }),
    "POST /api/vault/keys": () => ({ body: { id: NEW_KEY, status: "pending", createdAt: "2026-11-28T10:00:00.000Z" } }),
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
    setTimer: () => null,
    clearTimer: () => undefined,
    emit: (e) => events.push(e),
    device: () => "Chrome on macOS",
  });
}

const assertion = { id: CRED, rawId: CRED, type: "public-key", response: {}, clientExtensionResults: {} };

async function create(core: VaultCore, extra: { recreate?: boolean; credentialId?: string } = {}) {
  const buffer = prf.slice().buffer;
  await core.handle({ t: "stash", prf: buffer });
  const out = await core.handle({
    t: "createKey",
    assertion,
    credentialId: extra.credentialId ?? CRED,
    personId: ME,
    sessionTag: TAG,
    ...(extra.recreate ? { recreate: true } : {}),
  });
  return { buffer, out };
}

describe("la propria chiave, creata nel worker (fase 2)", () => {
  let core: VaultCore;
  beforeEach(() => {
    core = setup();
  });

  it("prepare `create`: con la cassaforte attiva e senza chiave, tutte le passkey (e la PRF locale)", async () => {
    expect(await core.handle({ t: "prepare" })).toEqual({ ok: false, code: "no_key" });
    expect(await core.handle({ t: "prepare", purpose: "create" })).toMatchObject({
      ok: true,
      onlyCredentialIds: [CRED, OTHER_CRED],
    });
    expect(calls.find((c) => c.path.endsWith("/passkey/options"))!.body).toEqual({ purpose: "vault" });
    activated = false;
    expect(await core.handle({ t: "prepare", purpose: "create" })).toEqual({ ok: false, code: "inactive" });
  });

  it("prepare `create` con una chiave viva: solo con `recreate`", async () => {
    myKey = { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" };
    expect(await core.handle({ t: "prepare", purpose: "create" })).toEqual({ ok: false, code: "has_key" });
    expect(await core.handle({ t: "prepare", purpose: "create", recreate: true })).toMatchObject({ ok: true });
  });

  it("createKey: verifica, crea la coppia, la sigilla con la PRF della passkey usata e apre; la PRF si azzera", async () => {
    const { buffer, out } = await create(core);
    expect(out).toEqual({ ok: true, status: "pending" });
    expect(new Uint8Array(buffer).every((b) => b === 0)).toBe(true);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.indexOf("POST /api/me/security/reauth/passkey/verify")).toBeLessThan(paths.indexOf("POST /api/vault/keys"));
    const body = calls.find((c) => c.path === "/api/vault/keys")!.body as {
      publicKey: string;
      seals: { passkeyId: string; sealedPrivateKey: string }[];
      device: string;
    };
    expect(body.seals).toHaveLength(1);
    expect(body.seals[0]!.passkeyId).toBe(PASSKEY_ID);
    expect(body.device).toBe("Chrome on macOS");
    // Il sigillo si apre con la PRF di quella passkey, sulla pubblica mandata.
    await expect(openPrivateKey(prf.slice().buffer, body.seals[0]!.sealedPrivateKey, body.publicKey)).resolves.toBeDefined();
    expect(JSON.stringify(calls)).not.toContain(toBase64Url(prf).slice(0, 10));
    expect(events.at(-1)).toMatchObject({ t: "state", state: "open" });
    expect(await core.handle({ t: "status" })).toMatchObject({ state: "open" });
  });

  it("createKey: una chiave viva non si sostituisce senza `recreate`, e la PRF si azzera senza chiamate di scrittura", async () => {
    myKey = { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" };
    const { buffer, out } = await create(core);
    expect(out).toEqual({ ok: false, code: "has_key" });
    expect(new Uint8Array(buffer).every((b) => b === 0)).toBe(true);
    expect(calls.some((c) => c.path === "/api/vault/keys")).toBe(false);
    expect((await create(core, { recreate: true })).out).toEqual({ ok: true, status: "pending" });
  });

  it("createKey: una passkey che non è della persona non sigilla niente", async () => {
    const { out } = await create(core, { credentialId: "c2Nvbm9zY2l1dGE" });
    expect(out).toEqual({ ok: false, code: "passkey_unknown" });
    expect(calls.some((c) => c.path === "/api/vault/keys")).toBe(false);
  });

  it("createKey: senza PRF nello stash niente, e un'altra persona sul server non crea", async () => {
    expect(await core.handle({ t: "createKey", assertion, credentialId: CRED, personId: ME, sessionTag: TAG })).toEqual({
      ok: false,
      code: "no_prf",
    });
    routes["GET /api/auth/me"] = () => ({ body: { user: { id: "p-bea" }, sessionTag: "srv-tag" } });
    expect((await create(core)).out).toEqual({ ok: false, code: "session" });
    expect(calls.some((c) => c.path === "/api/vault/keys")).toBe(false);
  });

  it("createKey su una cassaforte non attiva: niente", async () => {
    activated = false;
    expect((await create(core)).out).toEqual({ ok: false, code: "inactive" });
    expect(calls.some((c) => c.path === "/api/vault/keys")).toBe(false);
  });
});

describe("l'attivazione col kit di recupero, nel worker (fase 2)", () => {
  let core: VaultCore;
  beforeEach(() => {
    core = setup();
    activated = false;
    routes["POST /api/vault/activate"] = () => ({ body: { activated: true } });
  });

  it("kit: nasce nel worker; alla pagina il testo una volta, al server solo la pubblica tenuta qui", async () => {
    const kit = (await core.handle({ t: "kit", purpose: "activate" })) as { ok: true; kitText: string };
    expect(kit.ok).toBe(true);
    expect(kit.kitText).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
    expect(await core.handle({ t: "activate" })).toEqual({ ok: true });
    const body = calls.find((c) => c.path === "/api/vault/activate")!.body as { recoveryPublicKey: string };
    expect(typeof body.recoveryPublicKey).toBe("string");
    expect(JSON.stringify(calls)).not.toContain(kit.kitText.slice(0, 11));
    // Usata: un'altra attivazione con lo stesso kit non parte.
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "no_kit" });
  });

  it("activate senza un kit generato qui non parte; `forgetKit` lo butta", async () => {
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "no_kit" });
    await core.handle({ t: "kit", purpose: "activate" });
    await core.handle({ t: "forgetKit" });
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "no_kit" });
    expect(calls.some((c) => c.path === "/api/vault/activate")).toBe(false);
  });

  it("un kit per l'attivazione su una cassaforte già attiva non nasce", async () => {
    activated = true;
    expect(await core.handle({ t: "kit", purpose: "activate" })).toEqual({ ok: false, code: "vault_already_active" });
  });

  it("riconferma chiesta: il kit resta, e dopo la riconferma l'attivazione riparte con la stessa pubblica", async () => {
    let first = true;
    routes["POST /api/vault/activate"] = () => {
      if (first) {
        first = false;
        return { status: 403, body: { code: "reauth_required" } };
      }
      return { body: { activated: true } };
    };
    await core.handle({ t: "kit", purpose: "activate" });
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "reauth_required" });
    expect(await core.handle({ t: "activate" })).toEqual({ ok: true });
    const bodies = calls.filter((c) => c.path === "/api/vault/activate").map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("attivata da altri nel frattempo: il kit non vale più e si butta", async () => {
    routes["POST /api/vault/activate"] = () => ({ status: 409, body: { code: "vault_already_active" } });
    await core.handle({ t: "kit", purpose: "activate" });
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "vault_already_active" });
    routes["POST /api/vault/activate"] = () => ({ body: { activated: true } });
    expect(await core.handle({ t: "activate" })).toEqual({ ok: false, code: "no_kit" });
  });
});

describe("una passkey in più apre la cassaforte (fase 2)", () => {
  const LIVE_KEY = "11111111-1111-4111-8111-111111111111";
  let core: VaultCore;
  let pair: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  let prfNew: Uint8Array<ArrayBuffer>;

  beforeEach(async () => {
    core = setup();
    pair = await generatePersonKeyPair();
    prfNew = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealPrivateKey(prf.slice().buffer, pair.privateKeyPkcs8, pair.publicKey);
    myKey = { id: LIVE_KEY, status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" };
    const base = routes["GET /api/vault/status"]!;
    routes["GET /api/vault/status"] = () => {
      const out = base() as { body: Record<string, unknown> };
      return { body: { ...out.body, seals: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED }] } };
    };
    routes["GET /api/vault/keys/mine"] = () => ({
      body: {
        id: LIVE_KEY,
        publicKey: pair.publicKey,
        status: "confirmed",
        seals: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED, sealedPrivateKey: sealed }],
      },
    });
    routes[`POST /api/vault/keys/${LIVE_KEY}/seals`] = () => ({ status: 204, body: null });
  });

  const otherAssertion = { ...assertion, id: OTHER_CRED, rawId: OTHER_CRED };

  async function begin() {
    const a = prf.slice().buffer;
    await core.handle({ t: "stash", prf: a });
    const out = await core.handle({ t: "sealBegin", assertion, credentialId: CRED, personId: ME, passkeyId: OTHER_PASSKEY_ID });
    return { a, out };
  }

  async function finish(credentialId = OTHER_CRED) {
    const b = prfNew.slice().buffer;
    await core.handle({ t: "stash", prf: b });
    const out = await core.handle({ t: "sealFinish", assertion: otherAssertion, credentialId });
    return { b, out };
  }

  it("prepare `seal`: la sola passkey nuova; una che apre già, o d'altri, no", async () => {
    expect(await core.handle({ t: "prepare", purpose: "seal", passkeyId: OTHER_PASSKEY_ID })).toMatchObject({
      ok: true,
      onlyCredentialIds: [OTHER_CRED],
    });
    expect(await core.handle({ t: "prepare", purpose: "seal", passkeyId: PASSKEY_ID })).toEqual({ ok: false, code: "already_sealed" });
    expect(await core.handle({ t: "prepare", purpose: "seal", passkeyId: NEW_KEY })).toEqual({ ok: false, code: "passkey_unknown" });
  });

  it("due cerimonie: la prima apre, la seconda è la passkey nuova; il sigillo nuovo si apre con la sua PRF", async () => {
    const { a, out } = await begin();
    expect(out).toEqual({ ok: true });
    const done = await finish();
    expect(done.out).toEqual({ ok: true });
    expect(new Uint8Array(a).every((x) => x === 0)).toBe(true);
    expect(new Uint8Array(done.b).every((x) => x === 0)).toBe(true);
    expect(calls.filter((c) => c.path.endsWith("/passkey/verify"))).toHaveLength(2);
    const body = calls.find((c) => c.path.endsWith("/seals"))!.body as { passkeyId: string; sealedPrivateKey: string };
    expect(body.passkeyId).toBe(OTHER_PASSKEY_ID);
    await expect(openPrivateKey(prfNew.slice().buffer, body.sealedPrivateKey, pair.publicKey)).resolves.toBeDefined();
    expect(JSON.stringify(calls)).not.toContain(toBase64Url(prfNew).slice(0, 10));
  });

  it("la seconda passkey non è quella scelta: niente sigillo, e tutte e due le PRF si azzerano", async () => {
    const { a } = await begin();
    const { b, out } = await finish(CRED);
    expect(out).toEqual({ ok: false, code: "passkey_unknown" });
    expect(new Uint8Array(a).every((x) => x === 0)).toBe(true);
    expect(new Uint8Array(b).every((x) => x === 0)).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/seals"))).toBe(false);
  });

  it("la prima PRF non apre la chiave: si ferma lì", async () => {
    prf = crypto.getRandomValues(new Uint8Array(32));
    expect((await begin()).out).toEqual({ ok: false, code: "open_failed" });
    expect((await finish()).out).toEqual({ ok: false, code: "no_seal_pending" });
    expect(calls.some((c) => c.path.endsWith("/seals"))).toBe(false);
  });

  it("senza la prima cerimonia, o dopo 2 minuti, la seconda non sigilla", async () => {
    expect((await finish()).out).toEqual({ ok: false, code: "no_seal_pending" });
    await begin();
    clock += 2 * 60_000 + 1;
    expect((await finish()).out).toEqual({ ok: false, code: "no_seal_pending" });
    expect(calls.some((c) => c.path.endsWith("/seals"))).toBe(false);
  });

  it("`discard` butta anche la prima PRF in attesa", async () => {
    const { a } = await begin();
    await core.handle({ t: "discard" });
    expect(new Uint8Array(a).every((x) => x === 0)).toBe(true);
    expect((await finish()).out).toEqual({ ok: false, code: "no_seal_pending" });
  });
});

describe("la rotazione del kit di recupero, nel worker (fase 2)", () => {
  const LIVE_KEY = "11111111-1111-4111-8111-111111111111";
  const C1 = "33333333-3333-4333-8333-333333333333";
  const PROJECT = "66666666-6666-4666-8666-666666666666";
  const CHALLENGE = "77777777-7777-4777-8777-777777777777";
  let core: VaultCore;
  let pair: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  let ciphertext: string;
  let missing: unknown[];
  let rotations: number;

  beforeEach(async () => {
    core = setup();
    pair = await generatePersonKeyPair();
    const sealed = await sealPrivateKey(prf.slice().buffer, pair.privateKeyPkcs8, pair.publicKey);
    const enc = await encryptPassword(C1, "Kx4!pa-77Wq");
    ciphertext = enc.ciphertext;
    const myCopy = await wrapItemKey(enc.itemKey, pair.publicKey, C1, LIVE_KEY);
    missing = [];
    rotations = 0;
    myKey = { id: LIVE_KEY, status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" };
    const base = routes["GET /api/vault/status"]!;
    routes["GET /api/vault/status"] = () => {
      const out = base() as { body: Record<string, unknown> };
      return { body: { ...out.body, seals: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED }] } };
    };
    routes["GET /api/vault/keys/mine"] = () => ({
      body: { id: LIVE_KEY, publicKey: pair.publicKey, status: "confirmed", seals: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED, sealedPrivateKey: sealed }] },
    });
    routes["GET /api/vault/recovery-key/preview"] = () => ({
      body: { personKeyId: LIVE_KEY, credentials: [{ id: C1, projectId: PROJECT, service: "AWS", label: null, wrappedKey: myCopy }], missing },
    });
    routes["POST /api/vault/actor-challenge"] = () => ({
      body: wrapActorChallenge(new Uint8Array(32).fill(7), pair.publicKey, CHALLENGE, LIVE_KEY).then((wrapped) => ({
        challengeId: CHALLENGE,
        personKeyId: LIVE_KEY,
        wrapped,
        expiresAt: "2026-11-28T10:05:00.000Z",
      })),
    });
    routes["POST /api/vault/recovery-key"] = () => {
      rotations += 1;
      return { status: 204, body: null };
    };
  });

  async function unlock() {
    await core.handle({ t: "prepare" });
    await core.handle({ t: "stash", prf: prf.slice().buffer });
    expect(await core.handle({ t: "unlock", assertion, credentialId: CRED, personId: ME, sessionTag: TAG })).toEqual({ ok: true });
  }

  it("il kit nuovo: ogni chiave d'oggetto ricifrata per la sua pubblica, con la prova; il kit nuovo apre la copia", async () => {
    await unlock();
    const kit = (await core.handle({ t: "kit", purpose: "rotate" })) as { ok: true; kitText: string };
    expect(kit.ok).toBe(true);
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: true });
    const body = calls.find((c) => c.path === "/api/vault/recovery-key")!.body as {
      recoveryPublicKey: string;
      copies: { credentialId: string; wrappedKey: string }[];
      actorProof: { challengeId: string };
    };
    expect(body.actorProof.challengeId).toBe(CHALLENGE);
    expect(body.copies.map((c) => c.credentialId)).toEqual([C1]);
    const recovery = await parseRecoveryKit(kit.kitText);
    const itemKey = await unwrapItemKey(body.copies[0]!.wrappedKey, recovery, C1, "recovery");
    expect(await decryptPassword(C1, ciphertext, itemKey)).toBe("Kx4!pa-77Wq");
    // Usato: non si ruota due volte con lo stesso kit.
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "no_kit" });
  });

  it("una credenziale senza la propria copia: niente kit, e la pagina sa quali", async () => {
    missing = [{ id: C1, projectId: PROJECT, service: "Senza copia", label: null }];
    expect(await core.handle({ t: "kit", purpose: "rotate" })).toEqual({
      ok: false,
      code: "missing",
      missing: [{ id: C1, projectId: PROJECT, service: "Senza copia", label: null }],
    });
  });

  it("a cassaforte chiusa non ruota, e il kit resta per dopo lo sblocco", async () => {
    await core.handle({ t: "kit", purpose: "rotate" });
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "vault_locked" });
    await unlock();
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: true });
  });

  it("un kit dell'attivazione non vale per la rotazione", async () => {
    await unlock();
    activated = false;
    await core.handle({ t: "kit", purpose: "activate" });
    activated = true;
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: false, code: "no_kit" });
    expect(rotations).toBe(0);
  });

  it("`recipients_changed`: si rilegge l'anteprima e si riprova una volta, con lo stesso kit", async () => {
    await unlock();
    routes["POST /api/vault/recovery-key"] = () => {
      rotations += 1;
      return rotations === 1 ? { status: 409, body: { code: "recipients_changed" } } : { status: 204, body: null };
    };
    await core.handle({ t: "kit", purpose: "rotate" });
    expect(await core.handle({ t: "rotateKit", personId: ME, sessionTag: TAG })).toEqual({ ok: true });
    const bodies = calls.filter((c) => c.path === "/api/vault/recovery-key").map((c) => (c.body as { recoveryPublicKey: string }).recoveryPublicKey);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(calls.filter((c) => c.path === "/api/vault/recovery-key/preview").length).toBeGreaterThanOrEqual(2);
  });
});

describe("il recupero col kit, nel worker (fase 2)", () => {
  const C1 = "33333333-3333-4333-8333-333333333333";
  const PROJECT = "66666666-6666-4666-8666-666666666666";
  const BEA_KEY = "88888888-8888-4888-8888-888888888888";
  let core: VaultCore;
  let kit: { publicKey: string; kitText: string };
  let bea: Awaited<ReturnType<typeof generatePersonKeyPair>>;
  let ciphertext: string;
  let recoveryCopy: string;
  let challenges: { challengeId: string; secret: string }[];
  let used: Set<string>;

  beforeEach(async () => {
    core = setup();
    kit = await generateRecoveryKit();
    bea = await generatePersonKeyPair();
    const enc = await encryptPassword(C1, "Kx4!pa-77Wq");
    ciphertext = enc.ciphertext;
    recoveryCopy = await wrapItemKey(enc.itemKey, kit.publicKey, C1, "recovery");
    challenges = [];
    used = new Set();
    routes["POST /api/vault/recovery/challenge"] = () => {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const challengeId = crypto.randomUUID();
      challenges.push({ challengeId, secret: toBase64Url(secret) });
      return {
        status: 201,
        body: wrapRecoveryChallenge(secret, kit.publicKey, challengeId).then((wrapped) => ({ challengeId, wrapped, expiresAt: "2026-11-28T10:05:00.000Z" })),
      };
    };
    const valid = (b: { challengeId: string; proof: string }) => challenges.some((c) => c.challengeId === b.challengeId && c.secret === b.proof) && !used.has(b.challengeId);
    routes["POST /api/vault/recovery/pending"] = () => {
      const b = calls.at(-1)!.body as { challengeId: string; proof: string };
      if (!valid(b)) return { status: 403, body: { code: "recovery_proof_invalid" } };
      return {
        body: {
          items: [
            {
              user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "bea@example.com" },
              personKey: { id: BEA_KEY, status: "pending", createdAt: "2026-11-27T10:00:00.000Z", device: "Firefox on Linux", fingerprintSource: bea.publicKey },
              credentials: [{ id: C1, projectId: PROJECT, service: "AWS", label: null, wrappedKey: recoveryCopy, keyVersion: "v1" }],
            },
          ],
        },
      };
    };
    routes[`POST /api/vault/recovery/confirm/${BEA_KEY}`] = () => {
      const b = calls.at(-1)!.body as { challengeId: string; proof: string };
      if (!valid(b)) return { status: 403, body: { code: "recovery_proof_invalid" } };
      used.add(b.challengeId);
      return { body: { personKeyId: BEA_KEY, status: "confirmed", saved: [C1], skipped: [] } };
    };
  });

  it("il kit si legge nel worker: al server solo la prova, alla pagina chi aspetta senza le copie", async () => {
    const out = (await core.handle({ t: "recoveryLoad", kitText: kit.kitText })) as { ok: true; items: Record<string, unknown>[] };
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ email: "bea@example.com", personKeyId: BEA_KEY, credentials: [{ id: C1, service: "AWS" }] });
    expect(JSON.stringify(out)).not.toContain(recoveryCopy.slice(0, 20));
    expect(JSON.stringify(calls)).not.toContain(kit.kitText.slice(0, 11));
  });

  it("un testo che non è un kit, o il kit di un'altra cassaforte", async () => {
    expect(await core.handle({ t: "recoveryLoad", kitText: "non è un kit" })).toEqual({ ok: false, code: "invalid_kit" });
    expect(calls).toHaveLength(0);
    const other = await generateRecoveryKit();
    expect(await core.handle({ t: "recoveryLoad", kitText: other.kitText })).toEqual({ ok: false, code: "wrong_kit" });
  });

  it("conferma: la copia di recupero ricifrata per la chiave della persona, con una prova per conferma", async () => {
    await core.handle({ t: "recoveryLoad", kitText: kit.kitText });
    const out = await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY });
    expect(out).toMatchObject({ ok: true, saved: 1, keyChanged: 0, notAllowed: 0, unopenable: 0 });
    const body = calls.find((c) => c.path === `/api/vault/recovery/confirm/${BEA_KEY}`)!.body as {
      copies: { credentialId: string; wrappedKey: string; keyVersion: string }[];
    };
    expect(body.copies.map((c) => [c.credentialId, c.keyVersion])).toEqual([[C1, "v1"]]);
    const privateKey = await crypto.subtle.importKey("pkcs8", bea.privateKeyPkcs8.slice(), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const itemKey = await unwrapItemKey(body.copies[0]!.wrappedKey, privateKey, C1, BEA_KEY);
    expect(await decryptPassword(C1, ciphertext, itemKey)).toBe("Kx4!pa-77Wq");
    // La prova dell'elenco l'ha consumata la conferma; la seconda ne chiede una nuova.
    const before = challenges.length;
    await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY });
    expect(challenges.length).toBeGreaterThan(before);
  });

  it("senza il kit caricato, o dopo `recoveryForget`, niente conferma", async () => {
    expect(await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY })).toEqual({ ok: false, code: "no_kit" });
    await core.handle({ t: "recoveryLoad", kitText: kit.kitText });
    await core.handle({ t: "recoveryForget" });
    expect(await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY })).toEqual({ ok: false, code: "no_kit" });
    expect(calls.some((c) => c.path.startsWith("/api/vault/recovery/confirm/"))).toBe(false);
  });

  it("una persona che non aspetta più: `not_pending`, senza bruciare la prova", async () => {
    await core.handle({ t: "recoveryLoad", kitText: kit.kitText });
    expect(await core.handle({ t: "recoveryConfirm", personKeyId: "99999999-9999-4999-8999-999999999999" })).toEqual({ ok: false, code: "not_pending" });
    expect(used.size).toBe(0);
  });

  it("una riconferma chiesta non butta il kit caricato", async () => {
    await core.handle({ t: "recoveryLoad", kitText: kit.kitText });
    const real = routes[`POST /api/vault/recovery/confirm/${BEA_KEY}`]!;
    routes[`POST /api/vault/recovery/confirm/${BEA_KEY}`] = () => ({ status: 403, body: { code: "reauth_required" } });
    expect(await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY })).toEqual({ ok: false, code: "reauth_required" });
    routes[`POST /api/vault/recovery/confirm/${BEA_KEY}`] = real;
    expect(await core.handle({ t: "recoveryConfirm", personKeyId: BEA_KEY })).toMatchObject({ ok: true, saved: 1 });
  });
});
