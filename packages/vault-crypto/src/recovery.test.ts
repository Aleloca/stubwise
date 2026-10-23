import { describe, expect, it } from "vitest";
import { generateRecoveryKit, parseRecoveryKit } from "./recovery.js";
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
