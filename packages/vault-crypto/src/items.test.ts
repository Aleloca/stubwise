import { describe, expect, it } from "vitest";
import { generatePersonKeyPair } from "./keys.js";
import {
  decryptPassword,
  encryptForInsert,
  encryptPassword,
  unwrapItemKey,
  wrapItemKey,
} from "./items.js";

describe("encryptPassword / decryptPassword", () => {
  it("andata e ritorno, formato v: 1, IV diverso a ogni cifratura", async () => {
    const { ciphertext, itemKey } = await encryptPassword("cred-1", "pàssw0rd ✓");
    const env = JSON.parse(ciphertext) as Record<string, unknown>;
    expect(env.v).toBe(1);
    expect(await decryptPassword("cred-1", ciphertext, itemKey)).toBe("pàssw0rd ✓");

    const again = await encryptPassword("cred-1", "pàssw0rd ✓");
    expect(JSON.parse(again.ciphertext).iv).not.toBe(env.iv);
  });

  it("la password cifrata incollata su un'altra credenziale non si decifra (AAD)", async () => {
    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    await expect(decryptPassword("cred-2", ciphertext, itemKey)).rejects.toThrow();
  });
});

describe("wrapItemKey / unwrapItemKey", () => {
  it("andata e ritorno, formato v: 1", async () => {
    const person = await generatePersonKeyPair();
    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, person.publicKey, "cred-1", "key-1");
    expect(JSON.parse(wrapped).v).toBe(1);
    const key = await unwrapItemKey(wrapped, person.privateKey, "cred-1", "key-1");
    expect(await decryptPassword("cred-1", ciphertext, key)).toBe("segreta");
  });

  it("la chiave aperta si può ricifrare per un altro lettore (conferma)", async () => {
    const a = await generatePersonKeyPair();
    const b = await generatePersonKeyPair();
    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const forA = await wrapItemKey(itemKey, a.publicKey, "cred-1", "key-a");
    const opened = await unwrapItemKey(forA, a.privateKey, "cred-1", "key-a");
    const forB = await wrapItemKey(opened, b.publicKey, "cred-1", "key-b");
    const key = await unwrapItemKey(forB, b.privateKey, "cred-1", "key-b");
    expect(await decryptPassword("cred-1", ciphertext, key)).toBe("segreta");
  });

  it("copia della chiave usata con un altro credentialId → errore", async () => {
    const person = await generatePersonKeyPair();
    const { itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, person.publicKey, "cred-1", "key-1");
    await expect(unwrapItemKey(wrapped, person.privateKey, "cred-2", "key-1")).rejects.toThrow();
  });

  it("copia della chiave usata con un altro recipientId → errore", async () => {
    const person = await generatePersonKeyPair();
    const { itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, person.publicKey, "cred-1", "key-1");
    await expect(unwrapItemKey(wrapped, person.privateKey, "cred-1", "recovery")).rejects.toThrow();
  });

  it("la copia per un lettore non si apre con la chiave privata di un altro", async () => {
    const a = await generatePersonKeyPair();
    const b = await generatePersonKeyPair();
    const { itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, a.publicKey, "cred-1", "key-1");
    await expect(unwrapItemKey(wrapped, b.privateKey, "cred-1", "key-1")).rejects.toThrow();
  });

  it("due copie per lo stesso destinatario usano chiavi effimere diverse", async () => {
    const person = await generatePersonKeyPair();
    const { itemKey } = await encryptPassword("cred-1", "segreta");
    const w1 = JSON.parse(await wrapItemKey(itemKey, person.publicKey, "cred-1", "k"));
    const w2 = JSON.parse(await wrapItemKey(itemKey, person.publicKey, "cred-1", "k"));
    expect(w1.epk).not.toBe(w2.epk);
  });
});

describe("encryptForInsert", () => {
  it("con 3 destinatari: ognuno decifra la stessa password", async () => {
    const people = await Promise.all([1, 2, 3].map(() => generatePersonKeyPair()));
    const ids = ["key-a", "key-b", "recovery"];
    const out = await encryptForInsert({
      credentialId: "cred-9",
      password: "condivisa",
      recipients: people.map((p, i) => ({ recipientId: ids[i]!, publicKey: p.publicKey })),
    });
    expect(JSON.parse(out.passwordCiphertext).v).toBe(1);
    expect(out.copies.map((c) => c.recipientId)).toEqual(ids);
    for (const [i, copy] of out.copies.entries()) {
      const key = await unwrapItemKey(copy.wrappedKey, people[i]!.privateKey, "cred-9", copy.recipientId);
      expect(await decryptPassword("cred-9", out.passwordCiphertext, key)).toBe("condivisa");
    }
  });
});
