import { encryptPassword, generatePersonKeyPair, wrapItemKey } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Show e Copy nella scheda (design §6, §14): `reveal` sul fetch catturato, la
// chiave della voce aperta non estraibile, e una password che arriva dopo la
// chiusura si scarta.

const CRED = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const ME = "p-ada";

let privateKey: CryptoKey;
let reveal: { passwordCiphertext: string; wrappedKey: string; personKeyId: string };
let bodies: unknown[];
let gate: Promise<void> | null;

beforeEach(async () => {
  bodies = [];
  gate = null;
  const pair = await generatePersonKeyPair();
  privateKey = pair.privateKey;
  const { ciphertext, itemKey } = await encryptPassword(CRED, "Kx4!pa-77Wq");
  reveal = { passwordCiphertext: ciphertext, wrappedKey: await wrapItemKey(itemKey, pair.publicKey, CRED, KEY_ID), personKeyId: KEY_ID };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      bodies.push({ path, body: JSON.parse(init.body as string) });
      if (gate) await gate;
      return path === `/api/credentials/${CRED}/reveal`
        ? new Response(JSON.stringify(reveal), { status: 200 })
        : new Response('{"code":"not_found"}', { status: 404 });
    }),
  );
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const load = async () => {
  const key = await import("./key");
  key.__resetKeyForTests();
  const { revealPassword } = await import("./credentials");
  return { key, revealPassword };
};

describe("Show e Copy nella scheda", () => {
  it("la password dalla copia di chi guarda, con l'azione registrata", async () => {
    const { key, revealPassword } = await load();
    key.open(privateKey, ME, "e0");
    expect(await revealPassword(CRED, "show", ME, "e0")).toBe("Kx4!pa-77Wq");
    expect(bodies).toEqual([{ path: `/api/credentials/${CRED}/reveal`, body: { action: "show" } }]);
  });

  it("a cassaforte chiusa: `vault_locked`, e nessuna chiamata al server", async () => {
    const { revealPassword } = await load();
    await expect(revealPassword(CRED, "copy", ME, "e0")).rejects.toThrow("vault_locked");
    expect(bodies).toEqual([]);
  });

  it("§14: una password che arriva DOPO la chiusura si scarta", async () => {
    const { key, revealPassword } = await load();
    key.open(privateKey, ME, "e0");
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const pending = revealPassword(CRED, "show", ME, "e0");
    key.lock("user");
    release();
    await expect(pending).rejects.toThrow("vault_locked");
  });
});
