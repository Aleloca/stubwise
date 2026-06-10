import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./secrets.js";

const key = randomBytes(32);

describe("encrypt/decrypt", () => {
  it("round-trip: decrypt(encrypt(x)) restituisce il plaintext", () => {
    const plaintext = JSON.stringify({ username: "bot", token: "super-segreto" });
    const payload = encrypt(plaintext, key);
    expect(decrypt(payload, key)).toBe(plaintext);
  });

  it("il payload è nel formato iv.authTag.ciphertext (tre segmenti base64)", () => {
    const payload = encrypt("ciao", key);
    const parts = payload.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      // base64 valido e non vuoto
      expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    // IV di 12 byte come da spec AES-GCM
    expect(Buffer.from(parts[0]!, "base64")).toHaveLength(12);
    // auth tag GCM di 16 byte
    expect(Buffer.from(parts[1]!, "base64")).toHaveLength(16);
  });

  it("due cifrature dello stesso plaintext producono payload diversi (IV casuale)", () => {
    const a = encrypt("stesso-contenuto", key);
    const b = encrypt("stesso-contenuto", key);
    expect(a).not.toBe(b);
    // Anche gli IV devono differire, non solo il ciphertext.
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);
  });

  it("decrypt con la chiave sbagliata lancia", () => {
    const payload = encrypt("segreto", key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(payload, wrongKey)).toThrow();
  });

  it("un payload manomesso (un byte del ciphertext alterato) lancia", () => {
    const payload = encrypt("segreto-da-manomettere", key);
    const [iv, authTag, ciphertext] = payload.split(".");
    const bytes = Buffer.from(ciphertext!, "base64");
    bytes[0]! ^= 0xff;
    const tampered = [iv, authTag, bytes.toString("base64")].join(".");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("un payload con formato non valido lancia", () => {
    expect(() => decrypt("non-un-payload-valido", key)).toThrow();
    expect(() => decrypt("a.b", key)).toThrow();
  });
});
