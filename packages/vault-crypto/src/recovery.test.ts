import { describe, expect, it } from "vitest";
import {
  generateRecoveryKit,
  openRecoveryChallenge,
  parseRecoveryKit,
  wrapRecoveryChallenge,
} from "./recovery.js";
import { decryptPassword, encryptPassword, unwrapItemKey, wrapItemKey } from "./items.js";

describe("generateRecoveryKit / parseRecoveryKit", () => {
  it("andata e ritorno: il kit apre le copie fatte per la sua pubblica", async () => {
    const kit = await generateRecoveryKit();
    expect(kit.kitText).toMatch(/^[A-Z2-7]{1,5}(-[A-Z2-7]{1,5})*$/);
    expect(Object.keys(JSON.parse(kit.publicKey)).sort()).toEqual(["crv", "kty", "x", "y"]);

    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, kit.publicKey, "cred-1", "recovery");
    const privateKey = await parseRecoveryKit(kit.kitText);
    expect(privateKey.extractable).toBe(false);
    const key = await unwrapItemKey(wrapped, privateKey, "cred-1", "recovery");
    expect(await decryptPassword("cred-1", ciphertext, key)).toBe("segreta");
  });

  it("tollera minuscole, spazi e a capo", async () => {
    const kit = await generateRecoveryKit();
    const messy = kit.kitText.toLowerCase().replaceAll("-", " ").replace(/(.{30})/g, "$1\n");
    await expect(parseRecoveryKit(messy)).resolves.toBeDefined();
  });

  it("un carattere sbagliato lancia, in qualunque posizione", async () => {
    const kit = await generateRecoveryKit();
    const chars = kit.kitText.replaceAll("-", "");
    for (const pos of [0, Math.floor(chars.length / 2), chars.length - 1]) {
      const c = chars[pos]!;
      const wrong = chars.slice(0, pos) + (c === "A" ? "B" : "A") + chars.slice(pos + 1);
      await expect(parseRecoveryKit(wrong)).rejects.toThrow();
    }
  });

  it("rifiuta caratteri fuori alfabeto e testo troncato", async () => {
    const kit = await generateRecoveryKit();
    await expect(parseRecoveryKit(kit.kitText.replace(/[A-Z]/, "1"))).rejects.toThrow();
    await expect(parseRecoveryKit(kit.kitText.slice(0, -6))).rejects.toThrow();
  });
});

describe("sfida di possesso del kit (wrapRecoveryChallenge / openRecoveryChallenge)", () => {
  const secret = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
  const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

  it("chi ha il kit ricava il segreto (base64url), legato all'id della sfida", async () => {
    const kit = await generateRecoveryKit();
    const s = secret();
    const wrapped = await wrapRecoveryChallenge(s, kit.publicKey, "sfida-1");
    const privateKey = await parseRecoveryKit(kit.kitText);
    expect(await openRecoveryChallenge(wrapped, privateKey, "sfida-1")).toBe(b64url(s));
    // Con un altro id, o con un altro kit, non si apre.
    await expect(openRecoveryChallenge(wrapped, privateKey, "sfida-2")).rejects.toThrow();
    const other = await parseRecoveryKit((await generateRecoveryKit()).kitText);
    await expect(openRecoveryChallenge(wrapped, other, "sfida-1")).rejects.toThrow();
  });

  it("una copia di recupero di una credenziale NON si apre come sfida (AAD diverso)", async () => {
    const kit = await generateRecoveryKit();
    const { itemKey } = await encryptPassword("sfida-1", "segreta");
    const copy = await wrapItemKey(itemKey, kit.publicKey, "sfida-1", "recovery");
    const privateKey = await parseRecoveryKit(kit.kitText);
    await expect(openRecoveryChallenge(copy, privateKey, "sfida-1")).rejects.toThrow();
  });

  it("il segreto dev'essere di 32 byte", async () => {
    const kit = await generateRecoveryKit();
    await expect(wrapRecoveryChallenge(new Uint8Array(16), kit.publicKey, "x")).rejects.toThrow();
  });
});
