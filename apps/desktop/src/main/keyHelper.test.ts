// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codesignVerifier,
  createKeyHelper,
  helperPath,
  helperRequirement,
  spawnRunner,
} from "./keyHelper";

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

  // I1, seconda revisione: la chiave è una voce del Keychain (per tag), e la
  // frase del Touch ID la fissa l'helper: la richiesta non la porta mai.
  it("create: la voce col tag dato; risponde solo la pubblica x9.63 (65 byte)", async () => {
    const pub = Buffer.alloc(65, 4);
    const { h, run } = helper(() => ({ ok: true, publicKey: pub.toString("base64") }));
    const made = await h.create("stubwise.vault.abc");
    expect(made.publicKey).toEqual(new Uint8Array(pub));
    expect(JSON.parse(run.mock.calls[0]![0])).toEqual({ cmd: "create", tag: "stubwise.vault.abc" });
  });

  it("ecdh: il tag e il punto effimero su stdin, nessuna frase; il segreto di 32 byte", async () => {
    const secret = Buffer.alloc(32, 7);
    const { h, run } = helper(() => ({ ok: true, secret: secret.toString("base64") }));
    const eph = new Uint8Array(65).fill(4);
    expect(await h.ecdh("stubwise.vault.abc", eph)).toEqual(new Uint8Array(secret));
    expect(JSON.parse(run.mock.calls[0]![0])).toEqual({
      cmd: "ecdh",
      tag: "stubwise.vault.abc",
      peer: Buffer.from(eph).toString("base64"),
    });
  });

  it("deleteKey: toglie la voce del tag", async () => {
    const { h, run } = helper(() => ({ ok: true }));
    await h.deleteKey("stubwise.vault.abc");
    expect(JSON.parse(run.mock.calls[0]![0])).toEqual({ cmd: "delete", tag: "stubwise.vault.abc" });
  });

  it("un tocco annullato o un errore dell'helper diventano il suo codice", async () => {
    await expect(
      helper(() => ({ ok: false, code: "cancelled" })).h.ecdh("k", new Uint8Array(65)),
    ).rejects.toThrow("cancelled");
    await expect(helper(() => "not json").h.create("t")).rejects.toThrow();
  });

  it("un segreto che non è di 32 byte, o una pubblica che non è di 65, sono un errore", async () => {
    await expect(
      helper(() => ({ ok: true, secret: Buffer.alloc(16).toString("base64") })).h.ecdh(
        "k",
        new Uint8Array(65),
      ),
    ).rejects.toThrow("invalid_response");
    await expect(
      helper(() => ({
        ok: true,
        publicKey: Buffer.alloc(33).toString("base64"),
      })).h.create("t"),
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

// Seconda revisione di sicurezza della cassaforte, I2: il main passa all'helper
// le password (per gli appunti) e le richieste di Touch ID. Prima di scrivergli
// QUALUNQUE cosa ne verifica la firma, sul processo GIÀ AVVIATO (per pid: si
// controlla il codice che gira, non un file che si può scambiare dopo la
// verifica), con un requisito esplicito: anchor apple generic, identifier e
// Team ID. Verifica fallita: l'helper si uccide e non riceve niente.
describe("la firma dell'helper (I2)", () => {
  it("il requisito: anchor apple generic, l'identifier e il Team ID; senza Team ID non c'è requisito", () => {
    expect(helperRequirement("ABCDE12345")).toBe(
      'anchor apple generic and identifier "dev.aleloca.stubwise.keyhelper" and certificate leaf[subject.OU] = "ABCDE12345"',
    );
    expect(helperRequirement("")).toBeNull();
    expect(helperRequirement('AB" or true')).toBeNull();
  });

  it("verificato: riceve la richiesta (cat la rimanda); la verifica vede il pid del processo avviato", async () => {
    const pids: number[] = [];
    const run = spawnRunner("/bin/cat", {
      verify: async (pid) => {
        pids.push(pid);
        return true;
      },
    });
    expect(await run('{"cmd":"available"}')).toBe('{"cmd":"available"}');
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  it("un helper che chiude lo stdin senza leggere (padre non fidato, senza firma): niente EPIPE non gestito", async () => {
    // Chiude lo stdin e resta vivo un poco: la scrittura trova la pipe chiusa.
    const dir = mkdtempSync(join(tmpdir(), "stubwise-helper-"));
    const script = join(dir, "closes-stdin");
    writeFileSync(script, "#!/bin/sh\nexec 0<&-\nsleep 0.3\n", { mode: 0o755 });
    try {
      const run = spawnRunner(script, {
        verify: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return true;
        },
      });
      await expect(run("x".repeat(1 << 20))).resolves.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non verificato: `unverified`, e il processo non ha ricevuto niente", async () => {
    const run = spawnRunner("/bin/cat", { verify: async () => false });
    await expect(run("segreto")).rejects.toThrow("unverified");
    const failing = spawnRunner("/bin/cat", {
      verify: async () => {
        throw new Error("codesign assente");
      },
    });
    await expect(failing("segreto")).rejects.toThrow("unverified");
  });

  it.runIf(process.platform === "darwin")(
    "codesignVerifier: un processo di sistema soddisfa «anchor apple», non un Team ID qualunque",
    async () => {
      const child = spawn("/bin/sleep", ["5"]);
      try {
        expect(await codesignVerifier("anchor apple")(child.pid!)).toBe(true);
        expect(await codesignVerifier(helperRequirement("ABCDE12345")!)(child.pid!)).toBe(false);
      } finally {
        child.kill();
      }
    },
  );
});

// I1, seconda parte: l'helper è un bundle (`Contents/Helpers/…app`), perché
// gli entitlements riservati del Keychain del team vogliono un profilo di
// provisioning incorporato, e un eseguibile nudo non può averlo.
describe("dove sta l'helper (I1)", () => {
  it("nel bundle dell'helper, dentro Contents/Helpers dell'app", () => {
    expect(helperPath("/Applications/Stubwise.app/Contents/MacOS/Stubwise")).toBe(
      "/Applications/Stubwise.app/Contents/Helpers/StubwiseKeyHelper.app/Contents/MacOS/stubwise-keyhelper",
    );
  });
});
