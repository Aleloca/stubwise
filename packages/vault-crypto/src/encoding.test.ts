import { describe, expect, it } from "vitest";
import {
  fromBase32,
  fromBase64Url,
  parseEnvelope,
  toBase32,
  toBase64Url,
} from "./encoding.js";

describe("base64url", () => {
  it("andata e ritorno, senza padding né caratteri non URL-safe", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it("rifiuta caratteri fuori alfabeto", () => {
    expect(() => fromBase64Url("ab+c")).toThrow();
  });
});

describe("base32 (RFC 4648, senza padding)", () => {
  it("vettori dell'RFC", () => {
    const enc = (s: string) => toBase32(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("MY");
    expect(enc("fo")).toBe("MZXQ");
    expect(enc("foo")).toBe("MZXW6");
    expect(enc("foob")).toBe("MZXW6YQ");
    expect(enc("fooba")).toBe("MZXW6YTB");
    expect(enc("foobar")).toBe("MZXW6YTBOI");
  });

  it("andata e ritorno su lunghezze qualsiasi", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(fromBase32(toBase32(bytes))).toEqual(bytes);
    }
  });

  it("rifiuta caratteri fuori alfabeto e bit di coda non nulli", () => {
    expect(() => fromBase32("MZXW1")).toThrow();
    // "MY" = "f"; "MZ" ha a 1 un bit che non appartiene a nessun byte.
    expect(() => fromBase32("MZ")).toThrow();
  });
});

describe("parseEnvelope", () => {
  it("rifiuta una versione diversa da 1", () => {
    expect(() => parseEnvelope(JSON.stringify({ v: 2, iv: "", ct: "" }), ["iv", "ct"])).toThrow();
  });

  it("rifiuta un campo mancante o non stringa", () => {
    expect(() => parseEnvelope(JSON.stringify({ v: 1, iv: "AA" }), ["iv", "ct"])).toThrow();
    expect(() => parseEnvelope(JSON.stringify({ v: 1, iv: "AA", ct: 3 }), ["iv", "ct"])).toThrow();
  });

  it("rifiuta un JSON non valido", () => {
    expect(() => parseEnvelope("{", ["iv"])).toThrow();
  });
});
