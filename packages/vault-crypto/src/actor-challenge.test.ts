import { describe, expect, it } from "vitest";
import { openActorChallenge, wrapActorChallenge } from "./actor-challenge.js";
import { generatePersonKeyPair } from "./keys.js";
import { encryptPassword, wrapItemKey } from "./items.js";
import { generateRecoveryKit, parseRecoveryKit, wrapRecoveryChallenge } from "./recovery.js";

const secret = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

describe("sfida di possesso della chiave di persona (wrapActorChallenge / openActorChallenge)", () => {
  it("chi ha la privata ricava il segreto, legato a sfida e chiave", async () => {
    const pair = await generatePersonKeyPair();
    const s = secret();
    const wrapped = await wrapActorChallenge(s, pair.publicKey, "sfida-1", "key-1");
    expect(await openActorChallenge(wrapped, pair.privateKey, "sfida-1", "key-1")).toBe(b64url(s));
    await expect(openActorChallenge(wrapped, pair.privateKey, "sfida-2", "key-1")).rejects.toThrow();
    await expect(openActorChallenge(wrapped, pair.privateKey, "sfida-1", "key-2")).rejects.toThrow();
    const other = await generatePersonKeyPair();
    await expect(openActorChallenge(wrapped, other.privateKey, "sfida-1", "key-1")).rejects.toThrow();
  });

  it("una copia di credenziale per la persona NON si apre come sfida (AAD diverso)", async () => {
    const pair = await generatePersonKeyPair();
    const { itemKey } = await encryptPassword("sfida-1", "segreta");
    const copy = await wrapItemKey(itemKey, pair.publicKey, "sfida-1", "key-1");
    await expect(openActorChallenge(copy, pair.privateKey, "sfida-1", "key-1")).rejects.toThrow();
  });

  it("una sfida del kit di recupero NON si apre come sfida della persona, e viceversa", async () => {
    const kit = await generateRecoveryKit();
    const recoveryKey = await parseRecoveryKit(kit.kitText);
    const recoveryWrapped = await wrapRecoveryChallenge(secret(), kit.publicKey, "sfida-1");
    await expect(openActorChallenge(recoveryWrapped, recoveryKey, "sfida-1", "recovery")).rejects.toThrow();
  });

  it("il segreto dev'essere di 32 byte", async () => {
    const pair = await generatePersonKeyPair();
    await expect(wrapActorChallenge(new Uint8Array(16), pair.publicKey, "x", "k")).rejects.toThrow();
  });
});
