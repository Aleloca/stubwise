import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/**
 * Autenticatore WebAuthn software per i test: una coppia di chiavi ES256
 * (P-256) di `node:crypto` e le strutture costruite a mano — `clientDataJSON`,
 * `authenticatorData` (hash dell'rpID, flag, contatore), attestazione `none`
 * per la registrazione e firma su `authenticatorData || sha256(clientDataJSON)`
 * per l'uso. Così la verifica che il server fa è quella VERA di
 * `@simplewebauthn/server`, non un doppio.
 *
 * Ogni chiamata può falsare un pezzo (`origin`, `challenge`, `rpID`) per
 * provare un rifiuto.
 */
export class SoftAuthenticator {
  readonly credentialId: string;
  /** Chiave pubblica COSE in base64url: quella che il server salva. */
  readonly publicKey: string;
  counter = 0;
  private readonly privateKey: KeyObject;

  constructor(
    private readonly rp: { rpID: string; origin: string },
    opts: { counter?: number } = {},
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.credentialId = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
    const jwk = publicKey.export({ format: "jwk" });
    // COSE_Key EC2: kty=2, alg=-7 (ES256), crv=1 (P-256), x, y.
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]);
    this.publicKey = isoBase64URL.fromBuffer(isoCBOR.encode(cose));
    this.counter = opts.counter ?? 0;
  }

  /** Risposta a `navigator.credentials.create()` con attestazione `none`. */
  register(
    options: { challenge: string },
    fake: { origin?: string; challenge?: string; rpID?: string } = {},
  ): RegistrationResponseJSON {
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, fake);
    const credId = isoBase64URL.toBuffer(this.credentialId);
    const cose = isoBase64URL.toBuffer(this.publicKey);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      // UP | UV | AT (dati della credenziale attestata presenti).
      this.authDataHead(0x45, fake.rpID),
      Buffer.alloc(16), // aaguid
      credLen,
      credId,
      cose,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([
        ["fmt", "none"],
        ["attStmt", new Map<string, never>()],
        ["authData", new Uint8Array(authData)],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** Risposta a `navigator.credentials.get()`: alza il contatore e firma. */
  assert(
    options: { challenge: string },
    fake: { origin?: string; challenge?: string; rpID?: string } = {},
  ): AuthenticationResponseJSON {
    this.counter += 1;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, fake);
    // UP | UV.
    const authData = this.authDataHead(0x05, fake.rpID);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authData)),
        signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
      },
    };
  }

  private clientData(
    type: string,
    challenge: string,
    fake: { origin?: string; challenge?: string },
  ): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
      Buffer.from(
        JSON.stringify({
          type,
          challenge: fake.challenge ?? challenge,
          origin: fake.origin ?? this.rp.origin,
          crossOrigin: false,
        }),
      ),
    );
  }

  private authDataHead(flags: number, rpID?: string): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([
      createHash("sha256")
        .update(rpID ?? this.rp.rpID)
        .digest(),
      Buffer.from([flags]),
      counter,
    ]);
  }
}
