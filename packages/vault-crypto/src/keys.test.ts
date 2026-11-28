import { describe, expect, it, vi } from "vitest";
import { parseEnvelope } from "./encoding.js";
import {
  HKDF_INFO,
  PRF_INPUT,
  hkdfAesKey,
  generatePersonKeyPair,
  keyFingerprint,
  openPrivateKey,
  resealPrivateKey,
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
    const sealed = await sealPrivateKey(out, pair.privateKeyPkcs8, pair.publicKey);
    expect(JSON.parse(sealed).v).toBe(1);

    const opened = await openPrivateKey(out, sealed, pair.publicKey);
    expect(opened.extractable).toBe(false);

    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, pair.publicKey, "cred-1", "key-1");
    const key = await unwrapItemKey(wrapped, opened, "cred-1", "key-1");
    expect(await decryptPassword("cred-1", ciphertext, key)).toBe("segreta");
  });

  it("un PRF output diverso non apre la chiave privata", async () => {
    const pair = await generatePersonKeyPair();
    const sealed = await sealPrivateKey(prf(), pair.privateKeyPkcs8, pair.publicKey);
    await expect(openPrivateKey(prf(), sealed, pair.publicKey)).rejects.toThrow();
  });

  it("AAD = la pubblica: con un'ALTRA pubblica il sigillo non si apre (il server non scambia la chiave)", async () => {
    const pair = await generatePersonKeyPair();
    const other = await generatePersonKeyPair();
    const out = prf();
    const sealed = await sealPrivateKey(out, pair.privateKeyPkcs8, pair.publicKey);
    await expect(openPrivateKey(out, sealed, other.publicKey)).rejects.toThrow();
  });

  it("il sigillo HA un AAD: senza, la stessa chiave di sblocco non lo decifra", async () => {
    const pair = await generatePersonKeyPair();
    const out = prf();
    const { iv, ct } = parseEnvelope(await sealPrivateKey(out, pair.privateKeyPkcs8, pair.publicKey), ["iv", "ct"]);
    const key = await hkdfAesKey(out, HKDF_INFO.unlock);
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct)).rejects.toThrow();
  });

  it("non sigilla una privata con una pubblica che non è la sua", async () => {
    const pair = await generatePersonKeyPair();
    const other = await generatePersonKeyPair();
    await expect(sealPrivateKey(prf(), pair.privateKeyPkcs8, other.publicKey)).rejects.toThrow(
      /non corrisponde/,
    );
  });
});

describe("resealPrivateKey", () => {
  it("il sigillo nuovo si apre col PRF della passkey nuova e dà la STESSA chiave", async () => {
    const pair = await generatePersonKeyPair();
    const prfOld = prf();
    const prfNew = prf();
    const sealed = await sealPrivateKey(prfOld, pair.privateKeyPkcs8, pair.publicKey);
    const resealed = await resealPrivateKey(prfOld, sealed, prfNew, pair.publicKey);
    expect(JSON.parse(resealed).v).toBe(1);
    // Il vecchio PRF non apre il sigillo nuovo.
    await expect(openPrivateKey(prfOld, resealed, pair.publicKey)).rejects.toThrow();

    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const wrapped = await wrapItemKey(itemKey, pair.publicKey, "cred-1", "key-1");
    const viaOriginal = await unwrapItemKey(
      wrapped,
      await openPrivateKey(prfOld, sealed, pair.publicKey),
      "cred-1",
      "key-1",
    );
    const viaResealed = await unwrapItemKey(
      wrapped,
      await openPrivateKey(prfNew, resealed, pair.publicKey),
      "cred-1",
      "key-1",
    );
    expect(await decryptPassword("cred-1", ciphertext, viaOriginal)).toBe("segreta");
    expect(await decryptPassword("cred-1", ciphertext, viaResealed)).toBe("segreta");
  });

  it("un PRF vecchio sbagliato lancia, senza sigillo", async () => {
    const pair = await generatePersonKeyPair();
    const sealed = await sealPrivateKey(prf(), pair.privateKeyPkcs8, pair.publicKey);
    await expect(resealPrivateKey(prf(), sealed, prf(), pair.publicKey)).rejects.toThrow();
  });

  it("con un'altra pubblica non risigilla", async () => {
    const pair = await generatePersonKeyPair();
    const other = await generatePersonKeyPair();
    const prfOld = prf();
    const sealed = await sealPrivateKey(prfOld, pair.privateKeyPkcs8, pair.publicKey);
    await expect(resealPrivateKey(prfOld, sealed, prf(), other.publicKey)).rejects.toThrow();
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

describe("M-2: la verifica della coppia non esporta la privata", () => {
  it("sigillare e aprire non chiamano mai exportKey sulla privata", async () => {
    const { generatePersonKeyPair: gen, sealPrivateKey: seal, openPrivateKey: openKey } = await import("./keys.js");
    const pair = await gen();
    const prf = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const orig = crypto.subtle.exportKey.bind(crypto.subtle);
    const exported: KeyType[] = [];
    crypto.subtle.exportKey = (async (format: KeyFormat, key: CryptoKey) => {
      exported.push(key.type);
      return orig(format as "jwk", key);
    }) as typeof crypto.subtle.exportKey;
    try {
      const sealed = await seal(prf, pair.privateKeyPkcs8, pair.publicKey);
      await openKey(prf, sealed, pair.publicKey);
    } finally {
      crypto.subtle.exportKey = orig as typeof crypto.subtle.exportKey;
    }
    expect(exported).not.toContain("private");
  });
});

describe("m-4: hkdfAesKey non lascia copie del segreto", () => {
  it("la copia passata a importKey è azzerata dopo, e la chiave funziona", async () => {
    const seen: Uint8Array[] = [];
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "importKey").mockImplementation(((format: string, data: BufferSource, ...rest: unknown[]) => {
      if (format === "raw" && data instanceof Uint8Array) seen.push(data);
      return (real as (...a: unknown[]) => Promise<CryptoKey>)(format, data, ...rest);
    }) as never);
    try {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const key = await hkdfAesKey(secret, HKDF_INFO.unlock);
      expect(key.algorithm.name).toBe("AES-GCM");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.every((b) => b === 0)).toBe(true);
      expect(secret.some((b) => b !== 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

