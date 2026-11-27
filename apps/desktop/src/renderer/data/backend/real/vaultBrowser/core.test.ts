import {
  PRF_INPUT,
  encryptPassword,
  generatePersonKeyPair,
  sealPrivateKey,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDLE_MS, VaultCore, type CoreEvent } from "./core";
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

async function setup() {
  clock = Date.parse("2026-11-28T10:00:00Z");
  serverTag = "srv-tag-1";
  timers = [];
  calls = [];
  events = [];
  prf = crypto.getRandomValues(new Uint8Array(32));
  const pair = await generatePersonKeyPair();
  const sealed = await sealPrivateKey(prf.slice().buffer, pair.privateKeyPkcs8, pair.publicKey);
  const { ciphertext, itemKey } = await encryptPassword(C1, "Kx4!pa-77Wq");
  const wrappedKey = await wrapItemKey(itemKey, pair.publicKey, C1, KEY_ID);
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
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
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
  return { buffer, out: await core.handle({ t: "unlock", prf: buffer, assertion, credentialId: CRED, personId: ME, sessionTag: TAG }) };
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
    expect(
      await core.handle({ t: "unlock", prf: wrong, assertion, credentialId: CRED, personId: ME, sessionTag: TAG }),
    ).toEqual({ ok: false, code: "open_failed" });
    expect(new Uint8Array(wrong).every((b) => b === 0)).toBe(true);
    expect(await core.handle({ t: "status" })).toEqual({ state: "locked" });
  });
});
