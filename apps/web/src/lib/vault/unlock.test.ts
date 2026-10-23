import { PRF_INPUT } from "@stubwise/vault-crypto";
import { describe, expect, it } from "vitest";
import {
  deviceDescription,
  hasLiveKey,
  prfOutputOf,
  toVaultRequestOptions,
  withoutPrf,
} from "./unlock";

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("toVaultRequestOptions", () => {
  const options = {
    challenge: "abc",
    allowCredentials: [
      { id: "cred-a", type: "public-key" },
      { id: "cred-b", type: "public-key" },
    ],
    extensions: { prf: { eval: { first: toB64Url(PRF_INPUT) } } },
  };

  it("converte prf.eval.first da base64url in byte (simplewebauthn passa extensions così com'è)", () => {
    const out = toVaultRequestOptions(options) as {
      allowCredentials: unknown[];
      extensions: { prf: { eval: { first: Uint8Array } } };
    };
    expect(out.extensions.prf.eval.first).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.extensions.prf.eval.first)).toEqual(Array.from(PRF_INPUT));
    expect(out.allowCredentials).toHaveLength(2);
  });

  it("restringe allowCredentials alle passkey indicate", () => {
    const out = toVaultRequestOptions(options, ["cred-b"]) as { allowCredentials: { id: string }[] };
    expect(out.allowCredentials.map((c) => c.id)).toEqual(["cred-b"]);
  });
});

describe("prfOutputOf", () => {
  const withFirst = (first: unknown) => ({ clientExtensionResults: { prf: { results: { first } } } });

  it("legge un ArrayBuffer, una vista o una stringa base64url", () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    for (const first of [raw.buffer.slice(0), raw, toB64Url(raw)]) {
      const out = prfOutputOf(withFirst(first));
      expect(out).not.toBeNull();
      expect(Array.from(new Uint8Array(out!))).toEqual([1, 2, 3, 4]);
    }
  });

  it("null senza PRF (estensione assente, solo `enabled`, vuota)", () => {
    expect(prfOutputOf({ clientExtensionResults: {} })).toBeNull();
    expect(prfOutputOf({ clientExtensionResults: { prf: { enabled: false } } })).toBeNull();
    expect(prfOutputOf(withFirst(new ArrayBuffer(0)))).toBeNull();
    expect(prfOutputOf(undefined)).toBeNull();
  });
});

describe("withoutPrf", () => {
  it("toglie il segreto PRF e lascia il resto", () => {
    const response = {
      id: "cred-a",
      clientExtensionResults: { prf: { results: { first: new ArrayBuffer(32) } }, credProps: { rk: true } },
    };
    const out = withoutPrf(response);
    expect(out.clientExtensionResults).toEqual({ credProps: { rk: true } });
    expect(out.id).toBe("cred-a");
    // L'originale resta intatto (serve ancora per aprire la chiave).
    expect(response.clientExtensionResults.prf).toBeDefined();
  });
});

describe("deviceDescription", () => {
  it("browser e sistema dallo user agent", () => {
    expect(
      deviceDescription({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      }),
    ).toBe("Safari · macOS");
    expect(
      deviceDescription({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      }),
    ).toBe("Edge · Windows");
  });

  it("preferisce la piattaforma di userAgentData e resta entro 200 caratteri", () => {
    expect(
      deviceDescription({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        userAgentData: { platform: "macOS" },
      }),
    ).toBe("Chrome · macOS");
    expect(deviceDescription({ userAgent: "", userAgentData: { platform: "x".repeat(500) } })).toHaveLength(200);
  });
});

describe("hasLiveKey", () => {
  it("viva = pending o confermata; rifiutata o assente va ricreata", () => {
    const at = "2026-10-23T00:00:00.000Z";
    const id = "00000000-0000-4000-8000-000000000000";
    expect(hasLiveKey({ myKey: null })).toBe(false);
    expect(hasLiveKey({ myKey: { id, status: "rejected", createdAt: at } })).toBe(false);
    expect(hasLiveKey({ myKey: { id, status: "pending", createdAt: at } })).toBe(true);
    expect(hasLiveKey({ myKey: { id, status: "confirmed", createdAt: at } })).toBe(true);
  });
});
