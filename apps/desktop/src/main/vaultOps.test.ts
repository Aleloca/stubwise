// @vitest-environment node
import {
  encryptForInsert,
  keyFingerprint,
  unwrapItemKey,
  wrapActorChallenge,
} from "@stubwise/vault-crypto";
import { softwareDeviceKey } from "@stubwise/vault-crypto/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_CLEAR_MS, createVaultOps } from "./vaultOps";
import { VaultHttpError } from "./vaultRemote";

// Lotto 10 (72, a912fbcb8): le operazioni con la chiave di persona, fatte
// nel main col PAT desktop. La crittografia è VERA (`@stubwise/vault-crypto`);
// il server è finto. Al renderer escono: la password di «Show», esiti e
// conteggi — mai una copia della chiave, mai la password di «Copy».

const PK = "aaaaaaaa-0000-4000-8000-000000000001"; // la mia chiave di persona
const CRED = "cccccccc-0000-4000-8000-000000000001";
const OTHER_PK = "aaaaaaaa-0000-4000-8000-000000000002";
const CHALLENGE = "bbbbbbbb-0000-4000-8000-000000000001";

let me: { publicKey: string; privateKey: CryptoKey };
let other: { publicKey: string; privateKey: CryptoKey };
let stored: { passwordCiphertext: string; mine: string; recovery: string };

async function keyPair() {
  // Una coppia ECDH P-256 con la pubblica in JWK, come le chiavi di persona.
  const p = await softwareDeviceKey();
  return { publicKey: p.publicKey, privateKey: p.privateKey };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  me = await keyPair();
  other = await keyPair();
  const recovery = await keyPair();
  const enc = await encryptForInsert({
    credentialId: CRED,
    password: "Gq7#v2-LmpZ",
    recipients: [
      { recipientId: PK, publicKey: me.publicKey },
      { recipientId: "recovery", publicKey: recovery.publicKey },
    ],
  });
  stored = {
    passwordCiphertext: enc.passwordCiphertext,
    mine: enc.copies[0]!.wrappedKey,
    recovery: enc.copies[1]!.wrappedKey,
  };
});
afterEach(() => vi.useRealTimers());

type Call = { method: string; path: string; body?: unknown };

function setup(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  let open = true;
  let touches = 0;
  const lock = {
    use: async <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => {
      if (!open) throw new Error("vault_locked");
      return run(me.privateKey, PK);
    },
    markRevoked: vi.fn(() => {
      open = false;
    }),
    markDisabled: vi.fn(() => {
      open = false;
    }),
    // M5: le azioni che passano l'accesso riaprono dall'enclave (un tocco).
    useWithTouch: async <T>(run: (key: CryptoKey, personKeyId: string) => Promise<T>) => {
      if (!open) throw new Error("vault_locked");
      touches += 1;
      return run(me.privateKey, PK);
    },
  };
  // Gli appunti finti col modello dell'helper: ogni scrittura alza il changeCount.
  let clip = "";
  let changeCount = 0;
  const clipboard = {
    copy: async (t: string) => {
      clip = t;
      return ++changeCount;
    },
    clearIf: async (token: unknown) => {
      if (token === changeCount) clip = "";
    },
    read: () => clip,
  };
  const request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (!route) throw new VaultHttpError(404, "not_found");
    return route(body);
  };
  const ops = createVaultOps({ lock, request, clipboard });
  return {
    ops,
    calls,
    lock,
    clipboard,
    setClip: (t: string) => {
      clip = t;
      changeCount += 1;
    },
    touches: () => touches,
  };
}

const challengeRoute = () => ({
  "POST /api/vault/actor-challenge": async () => ({
    challengeId: CHALLENGE,
    personKeyId: PK,
    wrapped: await wrapActorChallenge(new Uint8Array(32).fill(7), me.publicKey, CHALLENGE, PK),
    expiresAt: "2026-11-24T12:00:00.000Z",
  }),
});

describe("le operazioni della cassaforte nel main", () => {
  it("«Show»: chiede `reveal` (show), apre la copia e dà la password", async () => {
    const { ops, calls } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => ({
        passwordCiphertext: stored.passwordCiphertext,
        wrappedKey: stored.mine,
        personKeyId: PK,
      }),
    });
    expect(await ops.show(CRED)).toEqual({ ok: true, password: "Gq7#v2-LmpZ" });
    expect(calls[0]!.body).toEqual({ action: "show" });
  });

  it("«Copy»: la password va negli appunti dal main, MAI al renderer; dopo 30 s si cancella se è ancora lei", async () => {
    const { ops, calls, clipboard, setClip } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => ({
        passwordCiphertext: stored.passwordCiphertext,
        wrappedKey: stored.mine,
        personKeyId: PK,
      }),
    });
    const out = await ops.copy(CRED);
    expect(out).toEqual({ ok: true });
    expect(JSON.stringify(out)).not.toContain("Gq7");
    expect(calls[0]!.body).toEqual({ action: "copy" });
    expect(clipboard.read()).toBe("Gq7#v2-LmpZ");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard.read()).toBe("");
    // Una seconda copia, poi la persona copia altro: gli appunti NON si toccano.
    await ops.copy(CRED);
    setClip("something else");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard.read()).toBe("something else");
  });

  // M4 (revisione di sicurezza): all'uscita dall'app gli appunti si
  // svuotano subito se contengono ancora la password copiata, senza aspettare.
  it("M4: `clearClipboard()` (a before-quit) svuota subito gli appunti se c'è ancora la password; altro no", async () => {
    const { ops, clipboard, setClip } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => ({
        passwordCiphertext: stored.passwordCiphertext,
        wrappedKey: stored.mine,
        personKeyId: PK,
      }),
    });
    await ops.copy(CRED);
    await ops.clearClipboard();
    expect(clipboard.read()).toBe("");
    await ops.copy(CRED);
    setClip("something else");
    await ops.clearClipboard();
    expect(clipboard.read()).toBe("something else");
  });

  it("cassaforte chiusa: `vault_locked`, niente chiesto al server", async () => {
    const { ops, calls, lock } = setup({});
    await lock.use(async () => null).catch(() => null);
    lock.markRevoked();
    expect(await ops.show(CRED)).toEqual({ ok: false, code: "vault_locked" });
    expect(calls).toEqual([]);
  });

  it("403 `device_seal_required`: il Mac non apre più (D-5), lo stato diventa `revoked`", async () => {
    const { ops, lock } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => {
        throw new VaultHttpError(403, "device_seal_required");
      },
    });
    expect(await ops.show(CRED)).toEqual({ ok: false, code: "device_seal_required" });
    expect(lock.markRevoked).toHaveBeenCalled();
  });

  it("VAULT_DESKTOP spento: un 404 `vault_desktop_disabled` è `disabled`, e la cassaforte lo sa", async () => {
    const { ops, lock } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => {
        throw new VaultHttpError(404, "vault_desktop_disabled");
      },
    });
    expect(await ops.show(CRED)).toEqual({ ok: false, code: "disabled" });
    expect(lock.markDisabled).toHaveBeenCalled();
  });

  it("M2: una credenziale che non c'è (404 `not_found`) non spegne la cassaforte", async () => {
    const { ops, lock } = setup({
      [`POST /api/credentials/${CRED}/reveal`]: () => {
        throw new VaultHttpError(404, "not_found");
      },
    });
    expect(await ops.show(CRED)).toEqual({ ok: false, code: "not_found" });
    expect(lock.markDisabled).not.toHaveBeenCalled();
  });

  it("M2: confermare chi non aspetta più è `not_pending`, e la cassaforte resta accesa", async () => {
    const { ops, lock } = setup({ "GET /api/vault/pending": () => ({ items: [] }) });
    expect(await ops.confirm(OTHER_PK)).toEqual({ ok: false, code: "not_pending" });
    expect(lock.markDisabled).not.toHaveBeenCalled();
  });

  it("condividere: anteprima, copia ricifrata per la persona, prova della propria chiave; un 409 `recipients_changed` riprova una volta", async () => {
    let posts = 0;
    const preview = (people: { personKeyId: string; publicKey: string }[]) => ({
      people: people.map((p) => ({
        userId: "dddddddd-0000-4000-8000-000000000001",
        email: "marco@x",
        ...p,
      })),
      waiting: [],
      wrappedKey: stored.mine,
      keyVersion: "v1",
    });
    const { ops, calls } = setup({
      ...challengeRoute(),
      [`GET /api/credentials/${CRED}/readers/preview?userId=dddddddd-0000-4000-8000-000000000001`]:
        () => preview([{ personKeyId: OTHER_PK, publicKey: other.publicKey }]),
      [`POST /api/credentials/${CRED}/readers`]: () => {
        posts += 1;
        if (posts === 1)
          throw new VaultHttpError(409, "recipients_changed", {
            preview: preview([{ personKeyId: OTHER_PK, publicKey: other.publicKey }]),
          });
        return { direct: [], effective: [] };
      },
    });
    expect(await ops.share(CRED, { userId: "dddddddd-0000-4000-8000-000000000001" })).toEqual({
      ok: true,
      waiting: [],
    });
    const writes = calls.filter((c) => c.method === "POST" && c.path.endsWith("/readers"));
    expect(writes).toHaveLength(2);
    const body = writes[1]!.body as {
      userId: string;
      copies: { recipientId: string; wrappedKey: string }[];
      keyVersion: string;
      actorProof: { challengeId: string; proof: string };
    };
    expect(body.userId).toBe("dddddddd-0000-4000-8000-000000000001");
    expect(body.keyVersion).toBe("v1");
    expect(body.actorProof.challengeId).toBe(CHALLENGE);
    // La copia si apre con la chiave di MARCO: la chiave d'oggetto è passata davvero.
    await expect(
      unwrapItemKey(body.copies[0]!.wrappedKey, other.privateKey, CRED, OTHER_PK),
    ).resolves.toBeTruthy();
  });

  it("togliere un lettore: la prova nel corpo del DELETE", async () => {
    const { ops, calls } = setup({
      ...challengeRoute(),
      [`DELETE /api/credentials/${CRED}/readers/r-1`]: () => ({ direct: [], effective: [] }),
    });
    expect(await ops.removeReader(CRED, "r-1")).toEqual({ ok: true });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect((del.body as { actorProof: { challengeId: string } }).actorProof.challengeId).toBe(
      CHALLENGE,
    );
  });

  it("gli accessi in attesa: al renderer persone, impronta e conteggi, MAI le copie della chiave", async () => {
    const { ops } = setup({
      "GET /api/vault/pending": () => ({
        items: [
          {
            user: { id: "dddddddd-0000-4000-8000-000000000001", email: "marco@x" },
            personKey: {
              id: OTHER_PK,
              status: "pending",
              createdAt: "2026-11-22T10:12:00.000Z",
              device: "Chrome on macOS",
              fingerprintSource: other.publicKey,
            },
            credentials: [
              {
                id: CRED,
                projectId: "eeeeeeee-0000-4000-8000-000000000001",
                service: "Aruba",
                label: null,
                wrappedKey: stored.mine,
                keyVersion: "v1",
              },
            ],
          },
        ],
      }),
    });
    const out = await ops.pending();
    expect(out).toEqual({
      ok: true,
      items: [
        {
          userId: "dddddddd-0000-4000-8000-000000000001",
          email: "marco@x",
          personKeyId: OTHER_PK,
          status: "pending",
          createdAt: "2026-11-22T10:12:00.000Z",
          device: "Chrome on macOS",
          fingerprint: await keyFingerprint(other.publicKey),
          credentials: [{ id: CRED, service: "Aruba", label: null }],
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(stored.mine);
  });

  it("confermare: copie ricifrate per la persona dalla lista fresca, con la prova; l'esito in conteggi", async () => {
    const { ops, calls } = setup({
      ...challengeRoute(),
      "GET /api/vault/pending": () => ({
        items: [
          {
            user: { id: "dddddddd-0000-4000-8000-000000000001", email: "marco@x" },
            personKey: {
              id: OTHER_PK,
              status: "pending",
              createdAt: "2026-11-22T10:12:00.000Z",
              device: null,
              fingerprintSource: other.publicKey,
            },
            credentials: [
              {
                id: CRED,
                projectId: "eeeeeeee-0000-4000-8000-000000000001",
                service: "Aruba",
                label: null,
                wrappedKey: stored.mine,
                keyVersion: "v1",
              },
            ],
          },
        ],
      }),
      [`POST /api/vault/pending/${OTHER_PK}/confirm`]: () => ({
        personKeyId: OTHER_PK,
        status: "confirmed",
        saved: [CRED],
        skipped: [],
      }),
    });
    expect(await ops.confirm(OTHER_PK)).toEqual({
      ok: true,
      saved: 1,
      keyChanged: 0,
      notAllowed: 0,
      unopenable: 0,
    });
    const post = calls.find((c) => c.path.endsWith("/confirm"))!.body as {
      copies: { credentialId: string; wrappedKey: string; keyVersion: string }[];
      actorProof: unknown;
    };
    expect(post.copies[0]).toMatchObject({ credentialId: CRED, keyVersion: "v1" });
    await expect(
      unwrapItemKey(post.copies[0]!.wrappedKey, other.privateKey, CRED, OTHER_PK),
    ).resolves.toBeTruthy();
    expect(post.actorProof).toBeTruthy();
  });

  it("rifiutare: con la prova", async () => {
    const { ops, calls } = setup({
      ...challengeRoute(),
      [`POST /api/vault/pending/${OTHER_PK}/reject`]: () => null,
    });
    expect(await ops.reject(OTHER_PK)).toEqual({ ok: true });
    expect(
      (calls.find((c) => c.path.endsWith("/reject"))!.body as { actorProof: unknown }).actorProof,
    ).toBeTruthy();
  });

  it("M5: condividere, confermare, rifiutare e togliere un lettore chiedono ciascuno un Touch ID; Show e Copy no", async () => {
    const { ops, touches } = setup({
      ...challengeRoute(),
      [`POST /api/vault/pending/${OTHER_PK}/reject`]: () => null,
      [`DELETE /api/credentials/${CRED}/readers/r-1`]: () => ({ direct: [], effective: [] }),
      [`POST /api/credentials/${CRED}/reveal`]: () => ({
        passwordCiphertext: stored.passwordCiphertext,
        wrappedKey: stored.mine,
        personKeyId: PK,
      }),
    });
    await ops.show(CRED);
    expect(touches()).toBe(0);
    await ops.reject(OTHER_PK);
    await ops.removeReader(CRED, "r-1");
    expect(touches()).toBe(2);
  });

  // I propri Mac (Preferenze → Security) dal main: l'elenco con `current`
  // (il sigillo di questo Mac) e l'impronta dalla pubblica; togliere un ALTRO
  // Mac vuole la cassaforte aperta (la prova della propria chiave) e la
  // riconferma del desktop, che il server chiede con `reauth_required`.
  it("i Mac: l'elenco con l'impronta e `current`; Remove con la prova", async () => {
    const MAC = "eeeeeeee-0000-4000-8000-000000000001";
    const { ops, calls } = setup({
      ...challengeRoute(),
      "GET /api/vault/device-seals": () => ({
        items: [
          {
            id: "eeeeeeee-0000-4000-8000-0000000000aa",
            deviceName: "MacBook Pro di Laura",
            devicePublicKey: other.publicKey,
            createdAt: "2026-11-24T09:00:00.000Z",
            lastUsedAt: "2026-11-25T09:00:00.000Z",
            current: true,
          },
          {
            id: MAC,
            deviceName: "iMac in ufficio",
            devicePublicKey: other.publicKey,
            createdAt: "2026-11-20T10:00:00.000Z",
            lastUsedAt: null,
            current: false,
          },
        ],
      }),
      [`DELETE /api/vault/device-seals/${MAC}`]: () => null,
    });
    const list = await ops.macs();
    expect(list).toMatchObject({
      ok: true,
      items: [
        { name: "MacBook Pro di Laura", current: true },
        {
          id: MAC,
          name: "iMac in ufficio",
          pairedAt: "2026-11-20T10:00:00.000Z",
          lastUsedAt: null,
          current: false,
          fingerprint: await keyFingerprint(other.publicKey),
        },
      ],
    });
    expect(await ops.removeMac(MAC)).toEqual({ ok: true });
    const del = calls.find((c) => c.path === `/api/vault/device-seals/${MAC}`)!;
    expect(del.method).toBe("DELETE");
    expect((del.body as { actorProof?: unknown }).actorProof).toBeDefined();
  });

  it("Remove di un Mac senza riconferma: `reauth_required` (il renderer apre «Confirm it's you»)", async () => {
    const MAC = "eeeeeeee-0000-4000-8000-000000000002";
    const { ops } = setup({
      ...challengeRoute(),
      [`DELETE /api/vault/device-seals/${MAC}`]: () => {
        throw new VaultHttpError(403, "reauth_required");
      },
    });
    expect(await ops.removeMac(MAC)).toEqual({ ok: false, code: "reauth_required" });
  });
});
