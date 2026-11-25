import {
  generateDeviceKeyPair,
  generatePersonKeyPair,
  importDeviceKey,
  openDeviceSeal,
  sealPrivateKey,
} from "@stubwise/vault-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lotto 10, la chiave del Mac: `sealForMac` sigilla la propria chiave di
 * persona per la chiave del Mac dell'associazione. Una cerimonia con la PRF;
 * la crittografia è VERA: il sigillo deve aprirsi con la privata del Mac.
 */

const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
const api = vi.hoisted(() => ({
  postReauthPasskeyOptions: vi.fn(),
  postReauthPasskeyVerify: vi.fn(),
  getMyVaultKey: vi.fn(),
  postVaultDeviceSeal: vi.fn(),
  postVaultKey: vi.fn(),
  postVaultKeySeal: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => webauthn);
vi.mock("../api", () => api);

const { sealForMac, VaultError } = await import("./unlock");

const CRED = "cred-b64url";
const PERSON_KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const DEVICE = "dddddddd-0000-4000-8000-000000000001";
const PROOF = { challengeId: "bbbbbbbb-0000-4000-8000-000000000001", proof: "p" };

let person: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let prf: Uint8Array;
let device: { publicKey: string; privateKey: CryptoKey };
const status = {
  myKey: { id: PERSON_KEY, status: "confirmed" },
  seals: [{ credentialIdB64url: CRED }],
} as never;

beforeEach(async () => {
  vi.clearAllMocks();
  person = await generatePersonKeyPair();
  prf = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealPrivateKey(prf.slice().buffer, person.privateKeyPkcs8, person.publicKey);
  const pair = await generateDeviceKeyPair();
  device = { publicKey: pair.publicKey, privateKey: await importDeviceKey(pair.privateKeyPkcs8) };
  api.postReauthPasskeyOptions.mockResolvedValue({
    challenge: "c",
    allowCredentials: [{ id: CRED, type: "public-key" }],
    extensions: { prf: { eval: { first: "AAAA" } } },
  });
  api.postReauthPasskeyVerify.mockResolvedValue({});
  webauthn.startAuthentication.mockImplementation(async () => ({
    id: CRED,
    clientExtensionResults: { prf: { results: { first: prf.slice().buffer } } },
  }));
  api.getMyVaultKey.mockResolvedValue({
    id: PERSON_KEY,
    publicKey: person.publicKey,
    seals: [{ credentialIdB64url: CRED, sealedPrivateKey: sealed }],
  });
  api.postVaultDeviceSeal.mockResolvedValue({ id: DEVICE, deviceName: "Mac", createdAt: "x" });
});

describe("sealForMac", () => {
  it("una cerimonia con la PRF; il sigillo si apre con la privata del Mac; state, id e prova nel corpo", async () => {
    const prove = vi.fn(async () => PROOF);
    await sealForMac(
      status,
      { state: "s-1", deviceId: DEVICE, devicePublicKey: device.publicKey },
      prove,
    );
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
    expect(api.postReauthPasskeyVerify).toHaveBeenCalledTimes(1);
    expect(prove).toHaveBeenCalledWith(expect.objectContaining({ personKeyId: PERSON_KEY }));
    const body = api.postVaultDeviceSeal.mock.calls[0]![0] as {
      pairingState: string;
      deviceId: string;
      seal: string;
      actorProof: unknown;
    };
    expect(body).toMatchObject({ pairingState: "s-1", deviceId: DEVICE, actorProof: PROOF });
    const opened = await openDeviceSeal({
      deviceSeal: body.seal,
      devicePrivateKey: device.privateKey,
      personPublicKey: person.publicKey,
      personKeyId: PERSON_KEY,
      deviceId: DEVICE,
    });
    expect(opened.type).toBe("private");
    // Il segreto PRF non va al server.
    expect(JSON.stringify(api.postReauthPasskeyVerify.mock.calls[0]![0])).not.toContain("prf");
  });

  it("senza una chiave viva: `no_seal`, nessuna cerimonia", async () => {
    await expect(
      sealForMac(
        { myKey: null, seals: [] } as never,
        { state: "s", deviceId: DEVICE, devicePublicKey: device.publicKey },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(VaultError);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it("una passkey senza PRF: niente sigillo", async () => {
    webauthn.startAuthentication.mockResolvedValue({ id: CRED, clientExtensionResults: {} });
    await expect(
      sealForMac(
        status,
        { state: "s", deviceId: DEVICE, devicePublicKey: device.publicKey },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(VaultError);
    expect(api.postVaultDeviceSeal).not.toHaveBeenCalled();
  });
});
