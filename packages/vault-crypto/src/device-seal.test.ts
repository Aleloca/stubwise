import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./encoding.js";
import { HKDF_INFO, generatePersonKeyPair, hkdfAesKey, rawPublicPoint, sealPrivateKey } from "./keys.js";
import { decryptPassword, encryptPassword, unwrapItemKey, wrapItemKey } from "./items.js";
import { generateDeviceKeyPair, importDeviceKey, openDeviceSeal, sealForDevice } from "./device-seal.js";

const prf = () => crypto.getRandomValues(new Uint8Array(32)).buffer;
const PERSON_KEY_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

/** Una persona con la sua chiave sigillata per la passkey, e un Mac. */
async function setup() {
  const person = await generatePersonKeyPair();
  const prfOutput = prf();
  const sealed = await sealPrivateKey(prfOutput, person.privateKeyPkcs8, person.publicKey);
  const device = await generateDeviceKeyPair();
  const deviceKey = await importDeviceKey(device.privateKeyPkcs8);
  const deviceSeal = await sealForDevice({
    prfOutput,
    sealed,
    personPublicKey: person.publicKey,
    personKeyId: PERSON_KEY_ID,
    devicePublicKey: device.publicKey,
    deviceId: DEVICE_ID,
  });
  return { person, prfOutput, sealed, device, deviceKey, deviceSeal };
}

describe("generateDeviceKeyPair / importDeviceKey", () => {
  it("pubblica = JWK con i soli campi pubblici; la privata importata NON è estraibile", async () => {
    const device = await generateDeviceKeyPair();
    const jwk = JSON.parse(device.publicKey) as Record<string, unknown>;
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk.crv).toBe("P-256");
    expect(device.privateKeyPkcs8.length).toBeGreaterThan(32);
    expect((await importDeviceKey(device.privateKeyPkcs8)).extractable).toBe(false);
  });
});

describe("sealForDevice / openDeviceSeal", () => {
  it("andata e ritorno: il Mac apre la chiave di persona, non estraibile, che apre le copie", async () => {
    const { person, deviceKey, deviceSeal } = await setup();
    const opened = await openDeviceSeal({ deviceSeal, devicePrivateKey: deviceKey, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, deviceId: DEVICE_ID });
    expect(opened.extractable).toBe(false);
    const { ciphertext, itemKey } = await encryptPassword("cred-1", "segreta");
    const copy = await wrapItemKey(itemKey, person.publicKey, "cred-1", PERSON_KEY_ID);
    expect(await decryptPassword("cred-1", ciphertext, await unwrapItemKey(copy, opened, "cred-1", PERSON_KEY_ID))).toBe("segreta");
  });

  it("formato: busta v1 con epk (punto non compresso, 65 byte), iv (12) e ct; nessun altro campo", async () => {
    const { deviceSeal } = await setup();
    const raw = JSON.parse(deviceSeal) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["ct", "epk", "iv", "v"]);
    expect(raw.v).toBe(1);
    const { epk, iv } = parseEnvelope(deviceSeal, ["epk", "iv", "ct"]);
    expect(epk.length).toBe(65);
    expect(epk[0]).toBe(4);
    expect(iv.length).toBe(12);
  });

  it("un ALTRO Mac non lo apre", async () => {
    const { person, deviceSeal } = await setup();
    const other = await importDeviceKey((await generateDeviceKeyPair()).privateKeyPkcs8);
    await expect(openDeviceSeal({ deviceSeal, devicePrivateKey: other, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, deviceId: DEVICE_ID })).rejects.toThrow();
  });

  it("AAD: con un altro deviceId o un altro personKeyId non si apre (un sigillo non si sposta su un'altra riga)", async () => {
    const { person, deviceKey, deviceSeal } = await setup();
    const other = "33333333-3333-4333-8333-333333333333";
    await expect(openDeviceSeal({ deviceSeal, devicePrivateKey: deviceKey, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, deviceId: other })).rejects.toThrow();
    await expect(openDeviceSeal({ deviceSeal, devicePrivateKey: deviceKey, personPublicKey: person.publicKey, personKeyId: other, deviceId: DEVICE_ID })).rejects.toThrow();
  });

  it("AAD = la pubblica di persona: se il server presenta un'altra pubblica, il Mac non apre (non cifrerebbe per chiavi d'altri)", async () => {
    const { deviceKey, deviceSeal } = await setup();
    const other = await generatePersonKeyPair();
    await expect(openDeviceSeal({ deviceSeal, devicePrivateKey: deviceKey, personPublicKey: other.publicKey, personKeyId: PERSON_KEY_ID, deviceId: DEVICE_ID })).rejects.toThrow();
  });

  it("il browser non sigilla con un PRF sbagliato, né per una pubblica di persona che non è quella del sigillo", async () => {
    const { person, sealed, prfOutput, device } = await setup();
    const base = { sealed, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, devicePublicKey: device.publicKey, deviceId: DEVICE_ID };
    await expect(sealForDevice({ ...base, prfOutput: prf() })).rejects.toThrow();
    await expect(sealForDevice({ ...base, prfOutput, personPublicKey: (await generatePersonKeyPair()).publicKey })).rejects.toThrow();
  });

  it("separazione dei domini: il sigillo del Mac non si apre come copia di una credenziale, né una copia come sigillo", async () => {
    const { person, device, deviceKey, deviceSeal } = await setup();
    await expect(unwrapItemKey(deviceSeal, deviceKey, PERSON_KEY_ID, DEVICE_ID)).rejects.toThrow();
    const { itemKey } = await encryptPassword("cred-1", "x");
    const copy = await wrapItemKey(itemKey, device.publicKey, PERSON_KEY_ID, DEVICE_ID);
    await expect(openDeviceSeal({ deviceSeal: copy, devicePrivateKey: deviceKey, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, deviceId: DEVICE_ID })).rejects.toThrow();
  });

  it("la forma esatta, ricalcolata a mano: HKDF con `info` suo e AAD `…device-seal:<personKeyId>:<deviceId>:` ‖ SHA-256(punto di persona); senza il punto, o con l'`info` delle copie, non si decifra", async () => {
    const { person, deviceKey, deviceSeal } = await setup();
    const { epk, iv, ct } = parseEnvelope(deviceSeal, ["epk", "iv", "ct"]);
    const eph = await crypto.subtle.importKey("raw", epk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: eph }, deviceKey, 256);
    const prefix = new TextEncoder().encode(`stubwise/vault/v1/device-seal:${PERSON_KEY_ID}:${DEVICE_ID}:`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await rawPublicPoint(person.publicKey)));
    const full = new Uint8Array([...prefix, ...digest]);
    const decrypt = async (info: string, aad: Uint8Array<ArrayBuffer>) =>
      crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, await hkdfAesKey(shared, info, epk), ct);
    expect(HKDF_INFO.deviceSeal).toBe("stubwise/vault/v1/device-seal");
    // Il controllo positivo: con la forma giusta si apre (altrimenti i due «no» sotto non provano niente).
    expect((await decrypt(HKDF_INFO.deviceSeal, full)).byteLength).toBeGreaterThan(32);
    await expect(decrypt(HKDF_INFO.deviceSeal, prefix)).rejects.toThrow();
    await expect(decrypt(HKDF_INFO.wrap, full)).rejects.toThrow();
  });

  it("gli id non possono contenere il separatore dell'AAD", async () => {
    const { person, sealed, prfOutput, device } = await setup();
    await expect(sealForDevice({ prfOutput, sealed, personPublicKey: person.publicKey, personKeyId: "a:b", devicePublicKey: device.publicKey, deviceId: DEVICE_ID })).rejects.toThrow(/id/);
    await expect(sealForDevice({ prfOutput, sealed, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, devicePublicKey: device.publicKey, deviceId: "" })).rejects.toThrow(/id/);
  });

  it("rifiuta una pubblica del dispositivo che non è un punto P-256", async () => {
    const { person, sealed, prfOutput } = await setup();
    await expect(sealForDevice({ prfOutput, sealed, personPublicKey: person.publicKey, personKeyId: PERSON_KEY_ID, devicePublicKey: '{"kty":"EC","crv":"P-256","x":"AA","y":"AA"}', deviceId: DEVICE_ID })).rejects.toThrow();
  });
});
