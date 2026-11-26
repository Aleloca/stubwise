// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = { path: "", encryption: true };
vi.mock("electron", () => ({
  app: { getPath: () => env.path },
  safeStorage: {
    isEncryptionAvailable: () => env.encryption,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (!s.startsWith("enc:")) throw new Error("bad");
      return s.slice(4);
    },
  },
}));

const device = await import("./vaultDevice");

/** Un helper finto del Secure Enclave: una pubblica P-256 vera (65 byte), il tag che riceve. */
async function fakeEnclave() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const tags: string[] = [];
  return {
    tags,
    create: async (tag: string) => {
      tags.push(tag);
      return { publicKey: raw };
    },
  };
}

// Lotto 10, design §1–§2 e §4: la chiave del dispositivo del Mac sta in
// `vault-device.bin`, cifrata con `safeStorage` (portachiavi di login), e
// vale SOLO per la sessione con cui è nata (istanza e PAT).

const ME = { instanceUrl: "https://stubwise.example", patId: "pat-1" };

beforeEach(() => {
  env.path = mkdtempSync(join(tmpdir(), "stubwise-vault-device-"));
  env.encryption = true;
});
afterEach(() => rmSync(env.path, { recursive: true, force: true }));

const file = () => join(env.path, "vault-device.bin");

describe("la chiave del dispositivo", () => {
  // I1, seconda revisione: la chiave è una voce del Keychain di data
  // protection (access group del Team ID). Su disco restano solo id, il TAG
  // della voce e la pubblica: nessun blob che un altro binario possa usare.
  it("una chiave nuova NEL Secure Enclave: la pubblica (JWK) esce, su disco solo il tag della voce, cifrato", async () => {
    const enclave = await fakeEnclave();
    const pair = await device.generateDeviceKey(enclave);
    expect(enclave.tags).toHaveLength(1);
    expect(enclave.tags[0]).toMatch(/^stubwise\.vault\.[0-9a-f]{32}$/);
    // La pubblica è un JWK (`devicePublicKeyFromRaw`, 72), come le chiavi di persona.
    expect(JSON.parse(pair.publicKey)).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(JSON.parse(pair.publicKey)).not.toHaveProperty("d");
    expect(device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: "pk-1", ...pair.stored })).toBe(
      true,
    );
    // Su disco, cifrata: la privata non compare in chiaro.
    const raw = readFileSync(file()).toString();
    expect(raw.startsWith("enc:")).toBe(true);
    const back = device.readDevice(ME)!;
    expect(back).toMatchObject({ deviceId: "d-1", personKeyId: "pk-1", publicKey: pair.publicKey });
    // Nessuna privata né blob su disco: solo il tag della voce del Keychain.
    expect(back.keyTag).toBe(enclave.tags[0]);
    expect(back).not.toHaveProperty("privateKey");
    expect(back).not.toHaveProperty("enclaveKey");
  });

  it("senza cifratura del sistema non si salva niente", async () => {
    env.encryption = false;
    const pair = await device.generateDeviceKey(await fakeEnclave());
    expect(device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored })).toBe(
      false,
    );
    expect(existsSync(file())).toBe(false);
  });

  it("un altro PAT (un altro login, anche della stessa persona) o un'altra istanza: il file non vale, e si cancella (§4)", async () => {
    const pair = await device.generateDeviceKey(await fakeEnclave());
    for (const other of [
      { ...ME, patId: "pat-2" },
      { ...ME, instanceUrl: "https://other.example" },
    ]) {
      device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored });
      expect(device.readDevice(other)).toBeNull();
      expect(existsSync(file())).toBe(false);
    }
  });

  it("un file della versione 1 (la pkcs8) o 2 (il blob dell'enclave) non vale, e si cancella", () => {
    for (const old of [
      { v: 1, privateKey: "pk8" },
      { v: 2, enclaveKey: "ENCLAVE-BLOB" },
    ]) {
      writeFileSync(
        file(),
        `enc:${JSON.stringify({ ...old, ...ME, deviceId: "d-1", personKeyId: null, publicKey: "{}" })}`,
      );
      expect(device.readDevice(ME)).toBeNull();
      expect(existsSync(file())).toBe(false);
    }
  });

  it("l'accordo di chiave passa dall'enclave per tag; la frase del Touch ID la fissa l'helper", async () => {
    const ecdh = async (...args: unknown[]) => {
      expect(args.length).toBe(2);
      expect([args[0], (args[1] as Uint8Array).length]).toEqual(["stubwise.vault.x", 65]);
      return new Uint8Array(32);
    };
    const agreement = device.deviceAgreement({ keyTag: "stubwise.vault.x" }, { ecdh });
    expect((await agreement.deriveBits(new Uint8Array(65))).length).toBe(32);
  });

  it("un file rotto o di un'altra versione non vale", () => {
    expect(device.readDevice(ME)).toBeNull();
    // Scritto da un'altra cifratura: non si apre.
    writeFileSync(file(), "garbage");
    expect(device.readDevice(ME)).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it("«dimentica» cancella il file E la voce del Keychain (anche un file d'altri che si scarta)", async () => {
    const deleted: string[] = [];
    device.setKeyDeleter(async (tag) => {
      deleted.push(tag);
    });
    const pair = await device.generateDeviceKey(await fakeEnclave());
    device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored });
    device.forgetDevice();
    expect(existsSync(file())).toBe(false);
    expect(device.readDevice(ME)).toBeNull();
    device.saveDevice({ ...ME, deviceId: "d-2", personKeyId: null, ...pair.stored });
    expect(device.readDevice({ ...ME, patId: "pat-2" })).toBeNull();
    expect(deleted).toEqual([pair.stored.keyTag, pair.stored.keyTag]);
    device.setKeyDeleter(null);
  });
});
