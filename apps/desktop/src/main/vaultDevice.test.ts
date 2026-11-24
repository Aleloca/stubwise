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
  it("una coppia P-256 nuova: la pubblica esce, la privata si rilegge da disco solo cifrata", async () => {
    const pair = await device.generateDeviceKey();
    // La pubblica è un JWK, come le chiavi di persona (`generateDeviceKeyPair`, 72).
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
    // La privata si importa NON estraibile, per usarla.
    const key = await device.devicePrivateKey(back);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "ECDH" });
  });

  it("senza cifratura del sistema non si salva niente", async () => {
    env.encryption = false;
    const pair = await device.generateDeviceKey();
    expect(device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored })).toBe(
      false,
    );
    expect(existsSync(file())).toBe(false);
  });

  it("un altro PAT (un altro login, anche della stessa persona) o un'altra istanza: il file non vale, e si cancella (§4)", async () => {
    const pair = await device.generateDeviceKey();
    for (const other of [
      { ...ME, patId: "pat-2" },
      { ...ME, instanceUrl: "https://other.example" },
    ]) {
      device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored });
      expect(device.readDevice(other)).toBeNull();
      expect(existsSync(file())).toBe(false);
    }
  });

  it("un file rotto o di un'altra versione non vale", () => {
    expect(device.readDevice(ME)).toBeNull();
    // Scritto da un'altra cifratura: non si apre.
    writeFileSync(file(), "garbage");
    expect(device.readDevice(ME)).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it("«dimentica» cancella il file", async () => {
    const pair = await device.generateDeviceKey();
    device.saveDevice({ ...ME, deviceId: "d-1", personKeyId: null, ...pair.stored });
    device.forgetDevice();
    expect(existsSync(file())).toBe(false);
    expect(device.readDevice(ME)).toBeNull();
  });
});
