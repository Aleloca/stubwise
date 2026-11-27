import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { listMacsOf, removeMacOf } from "./vaultMacsOf";

// I Mac di un'altra persona nella nuova app nel browser (ritiro del web
// vecchio, inventario 1.2), sulle rotte del browser del server.

const LAURA = "22222222-2222-4222-8222-222222222222";
const MAC = "33333333-3333-4333-8333-333333333333";
/** Una chiave pubblica P-256 vera, come la manda il server (JWK in JSON). */
async function publicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i Mac di un'altra persona", () => {
  it("l'elenco nella forma del prototipo: nome, associato, ultimo uso, impronta; nessuno è «questo Mac»", async () => {
    const PUB = await publicKey();
    installFakeServer({
      [`GET /api/vault/users/${LAURA}/device-seals`]: {
        body: {
          items: [
            { id: MAC, deviceName: "MacBook di Laura", devicePublicKey: PUB, createdAt: "2026-11-20T10:00:00.000Z", lastUsedAt: null, current: true },
          ],
        },
      },
    });
    const r = await listMacsOf(LAURA);
    if (!r.ok) throw new Error(r.code);
    expect(r.macs[0]).toMatchObject({ id: MAC, name: "MacBook di Laura", pairedAt: "2026-11-20T10:00:00.000Z", current: false });
    expect(r.macs[0]!.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it("togliere: il DELETE della rotta; la riconferma e il 404 come nel prototipo", async () => {
    const { seen } = installFakeServer({ [`DELETE /api/vault/users/${LAURA}/device-seals/${MAC}`]: { status: 204 } });
    expect(await removeMacOf(LAURA, MAC)).toEqual({ ok: true });
    expect(seen.at(-1)).toMatchObject({ method: "DELETE" });
    installFakeServer({
      [`DELETE /api/vault/users/${LAURA}/device-seals/${MAC}`]: { status: 403, body: { code: "reauth_required", message: "x" } },
    });
    expect(await removeMacOf(LAURA, MAC)).toEqual({ ok: false, code: "reauth_required" });
    installFakeServer({});
    expect(await removeMacOf(LAURA, MAC)).toEqual({ ok: false, code: "not_found" });
  });
});
