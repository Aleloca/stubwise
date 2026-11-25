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

/** Un helper finto del Secure Enclave: una pubblica P-256 vera (65 byte), un blob opaco. */
async function fakeEnclave() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { create: async () => ({ key: "ENCLAVE-BLOB", publicKey: raw }) };
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
  it("una chiave nuova NEL Secure Enclave: la pubblica (JWK) esce, su disco solo il blob dell'enclave, cifrato", async () => {
    const pair = await device.generateDeviceKey(await fakeEnclave());
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
    // Nessuna privata su disco: solo il blob che solo l'enclave di questo Mac sa usare.
    expect(back.enclaveKey).toBe("ENCLAVE-BLOB");
    expect(back).not.toHaveProperty("privateKey");
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

  it("un file della versione 1 (con la pkcs8, prima dell'enclave) non vale, e si cancella", () => {
    writeFileSync(
      file(),
      `enc:${JSON.stringify({ v: 1, ...ME, deviceId: "d-1", personKeyId: null, publicKey: "{}", privateKey: "pk8" })}`,
    );
    expect(device.readDevice(ME)).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it("l'accordo di chiave passa dall'enclave, con la frase del Touch ID", async () => {
    const ecdh = async (key: string, peer: Uint8Array, reason: string) => {
      expect([key, peer.length, reason]).toEqual(["ENCLAVE-BLOB", 65, "open the vault"]);
      return new Uint8Array(32);
    };
    const agreement = device.deviceAgreement(
      { enclaveKey: "ENCLAVE-BLOB" },
      { ecdh },
      "open the vault",
    );
    expect((await agreement.deriveBits(new Uint8Array(65))).length).toBe(32);
  });

  it("un file rotto o di un'altra versione non vale", () => {
    expect(device.readDevice(ME)).toBeNull();
    // Scritto da un'altra cifratura: non si apre.
    writeFileSync(file(), "garbage");
    expect(device.readDevice(ME)).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it("«dimentica» cancella il file", async () => {
    const pair = await device.generateDeviceKey(await fakeEnclave());
    device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored });
    device.forgetDevice();
    expect(existsSync(file())).toBe(false);
    expect(device.readDevice(ME)).toBeNull();
  });
});
