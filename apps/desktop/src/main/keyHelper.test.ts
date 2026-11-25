// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createKeyHelper } from "./keyHelper";

// Revisione di sicurezza della cassaforte, I1: il main parla con l'helper
// Swift del Secure Enclave (`native/keyhelper/main.swift`) con UNA richiesta
// JSON su stdin e una risposta JSON su stdout. Nessun segreto in argomenti o
// variabili d'ambiente. Qui l'helper è finto: si prova il protocollo.

function helper(respond: (req: Record<string, unknown>) => unknown) {
  const run = vi.fn(async (input: string) =>
    JSON.stringify(respond(JSON.parse(input) as Record<string, unknown>)),
  );
  return { h: createKeyHelper({ run }), run };
}

describe("l'helper del Secure Enclave", () => {
  it("available: enclave e biometria; un helper che non risponde vale «non disponibile»", async () => {
    expect(
      await helper(() => ({ ok: true, secureEnclave: true, biometry: true })).h.available(),
    ).toEqual({
      secureEnclave: true,
      biometry: true,
    });
    const broken = createKeyHelper({ run: async () => Promise.reject(new Error("ENOENT")) });
    expect(await broken.available()).toEqual({ secureEnclave: false, biometry: false });
  });

  it("create: il blob dell'enclave e la pubblica x9.63 (65 byte)", async () => {
    const pub = Buffer.alloc(65, 4);
    const { h, run } = helper(() => ({ ok: true, key: "S0VZ", publicKey: pub.toString("base64") }));
    const made = await h.create();
    expect(made.key).toBe("S0VZ");
    expect(made.publicKey).toEqual(new Uint8Array(pub));
    expect(JSON.parse(run.mock.calls[0]![0])).toEqual({ cmd: "create" });
  });

  it("ecdh: il punto effimero e la frase del Touch ID su stdin; il segreto di 32 byte", async () => {
    const secret = Buffer.alloc(32, 7);
    const { h, run } = helper(() => ({ ok: true, secret: secret.toString("base64") }));
    const eph = new Uint8Array(65).fill(4);
    expect(await h.ecdh("S0VZ", eph, "open the vault")).toEqual(new Uint8Array(secret));
    expect(JSON.parse(run.mock.calls[0]![0])).toEqual({
      cmd: "ecdh",
      key: "S0VZ",
      peer: Buffer.from(eph).toString("base64"),
      reason: "open the vault",
    });
  });

  it("un tocco annullato o un errore dell'helper diventano il suo codice", async () => {
    await expect(
      helper(() => ({ ok: false, code: "cancelled" })).h.ecdh("k", new Uint8Array(65), "r"),
    ).rejects.toThrow("cancelled");
    await expect(helper(() => "not json").h.create()).rejects.toThrow();
  });

  it("un segreto che non è di 32 byte, o una pubblica che non è di 65, sono un errore", async () => {
    await expect(
      helper(() => ({ ok: true, secret: Buffer.alloc(16).toString("base64") })).h.ecdh(
        "k",
        new Uint8Array(65),
        "r",
      ),
    ).rejects.toThrow("invalid_response");
    await expect(
      helper(() => ({
        ok: true,
        key: "k",
        publicKey: Buffer.alloc(33).toString("base64"),
      })).h.create(),
    ).rejects.toThrow("invalid_response");
  });

  it("copy e clear-if: gli appunti dall'helper (tipi Concealed/Transient), svuotati solo se nessuno li ha cambiati", async () => {
    const { h, run } = helper((req) =>
      req.cmd === "copy" ? { ok: true, changeCount: 12 } : { ok: true, cleared: true },
    );
    expect(await h.copy("pw")).toBe(12);
    expect(await h.clearIf(12)).toBe(true);
    expect(run.mock.calls.map((c) => JSON.parse(c[0]).cmd)).toEqual(["copy", "clear-if"]);
  });
});
