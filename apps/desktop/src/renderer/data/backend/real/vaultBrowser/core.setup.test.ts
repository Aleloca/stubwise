import { PRF_INPUT, generatePersonKeyPair, openPrivateKey, sealPrivateKey } from "@stubwise/vault-crypto";
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
      return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status ?? 200 });
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
