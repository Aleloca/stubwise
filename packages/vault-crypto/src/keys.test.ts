import { describe, expect, it } from "vitest";
import {
  PRF_INPUT,
  generatePersonKeyPair,
  keyFingerprint,
  openPrivateKey,
  sealPrivateKey,
} from "./keys.js";
import { decryptPassword, encryptPassword, unwrapItemKey, wrapItemKey } from "./items.js";

const prf = () => crypto.getRandomValues(new Uint8Array(32)).buffer;

describe("PRF_INPUT", () => {
  it("è lo SHA-256 dell'etichetta fissa", async () => {
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stubwise/vault/v1/prf")),
    );
    expect(PRF_INPUT).toEqual(expected);
    expect(PRF_INPUT.length).toBe(32);
  });
});

describe("generatePersonKeyPair", () => {
  it("pubblica = JWK con i soli campi pubblici; privata non estraibile", async () => {
    const pair = await generatePersonKeyPair();
    const jwk = JSON.parse(pair.publicKey) as Record<string, unknown>;
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKeyPkcs8).toBeInstanceOf(Uint8Array);
    expect(pair.privateKeyPkcs8.length).toBeGreaterThan(32);
  });
});

describe("sealPrivateKey / openPrivateKey", () => {
  it("andata e ritorno: la chiave aperta apre le copie per la pubblica", async () => {
    const pair = await generatePersonKeyPair();
    const out = prf();
    const sealed = await sealPrivateKey(out, pair.privateKeyPkcs8);
    expect(JSON.parse(sealed).v).toBe(1);

    const opened = await openPrivateKey(out, sealed);
    expect(opened.extractable).toBe(false);

    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, pair.publicKey, "cred-1", "key-1");
    const key = await unwrapItemKey(wrapped, opened, "cred-1", "key-1");
    expect(await decryptPassword("cred-1", ciphertext, key)).toBe("segreta");
  });

  it("un PRF output diverso non apre la chiave privata", async () => {
    const pair = await generatePersonKeyPair();
    const sealed = await sealPrivateKey(prf(), pair.privateKeyPkcs8);
    await expect(openPrivateKey(prf(), sealed)).rejects.toThrow();
  });
});

describe("keyFingerprint", () => {
  it("16 cifre esadecimali a gruppi di 4, stabile e distinta per chiave", async () => {
    const a = await generatePersonKeyPair();
    const b = await generatePersonKeyPair();
    const fa = await keyFingerprint(a.publicKey);
    expect(fa).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(await keyFingerprint(a.publicKey)).toBe(fa);
    // Indipendente dalla serializzazione: stesso punto, JSON riordinato.
    const jwk = JSON.parse(a.publicKey) as Record<string, string>;
    const reordered = JSON.stringify({ y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty });
    expect(await keyFingerprint(reordered)).toBe(fa);
    expect(await keyFingerprint(b.publicKey)).not.toBe(fa);
  });

  it("rifiuta una chiave che non è una pubblica P-256", async () => {
    await expect(keyFingerprint(JSON.stringify({ kty: "RSA" }))).rejects.toThrow();
    await expect(keyFingerprint("non json")).rejects.toThrow();
  });
});
