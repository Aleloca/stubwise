import { z } from "zod";

/**
 * Cassaforte delle credenziali (design
 * `docs/plans/2026-10-23-cassaforte-credenziali-design.md`): attivazione,
 * chiavi delle persone e kit di recupero. Il server riceve SOLO materiale
 * pubblico (chiavi pubbliche JWK) o cifrato (buste JSON `v: 1` di
 * `@stubwise/vault-crypto`): nessuna chiave privata né password in chiaro.
 */

/** Tetto di una busta cifrata (chiave privata sigillata, copia della chiave). */
const ENVELOPE_MAX = 8192;

/** Una busta cifrata di `@stubwise/vault-crypto`, opaca per il server. */
const envelopeSchema = z.string().min(1).max(ENVELOPE_MAX);

/**
 * Chiave PUBBLICA ECDH P-256 come JWK serializzato (`exportPublicKey` di
 * `@stubwise/vault-crypto`). Il server non la usa per cifrare, ma rifiuta
 * ciò che non lo è — e in particolare un JWK con `d`, cioè una chiave
 * PRIVATA mandata per errore: non deve mai arrivare qui, tanto meno restarci.
 */
export const vaultPublicKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      const jwk = JSON.parse(value) as Record<string, unknown> | null;
      return (
        typeof jwk === "object" &&
        jwk !== null &&
        jwk.kty === "EC" &&
        jwk.crv === "P-256" &&
        typeof jwk.x === "string" &&
        typeof jwk.y === "string" &&
        !("d" in jwk)
      );
    } catch {
      return false;
    }
  }, "Not a P-256 public JWK");

export const vaultPersonKeyStatusSchema = z.enum(["pending", "confirmed", "rejected", "superseded"]);
export type VaultPersonKeyStatusView = z.infer<typeof vaultPersonKeyStatusSchema>;

/**
 * Un sigillo della propria chiave privata, come lo vede il browser per
 * scegliere quello della passkey appena usata: `credentialIdB64url` è l'id
 * WebAuthn della passkey (base64url, quello che `navigator.credentials.get()`
 * restituisce come `id`).
 */
export const vaultSealRefSchema = z.object({
  passkeyId: z.uuid(),
  credentialIdB64url: z.string(),
});
export type VaultSealRef = z.infer<typeof vaultSealRefSchema>;

/** Risposta di `GET /api/vault/status`. `myKey`: l'ultima chiave della persona. */
export const vaultStatusResponseSchema = z.object({
  activated: z.boolean(),
  myKey: z
    .object({
      id: z.uuid(),
      status: vaultPersonKeyStatusSchema,
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  seals: z.array(vaultSealRefSchema),
});
export type VaultStatusResponse = z.infer<typeof vaultStatusResponseSchema>;

/** Corpo di `POST /api/vault/activate`: la sola chiave PUBBLICA di recupero. */
export const vaultActivateBodySchema = z.object({
  recoveryPublicKey: vaultPublicKeySchema,
});
export type VaultActivateBody = z.infer<typeof vaultActivateBodySchema>;

/** Un sigillo nuovo: la chiave privata cifrata con il segreto PRF di una passkey. */
export const vaultSealInputSchema = z.object({
  passkeyId: z.uuid(),
  sealedPrivateKey: envelopeSchema,
});
export type VaultSealInput = z.infer<typeof vaultSealInputSchema>;

/**
 * Corpo di `POST /api/vault/keys`. `device`: browser e sistema dichiarati
 * dal client, mostrati a chi conferma la chiave (testo libero, corto).
 */
export const vaultCreateKeyBodySchema = z.object({
  publicKey: vaultPublicKeySchema,
  seals: z.array(vaultSealInputSchema).min(1).max(20),
  device: z.string().trim().max(200),
});
export type VaultCreateKeyBody = z.infer<typeof vaultCreateKeyBodySchema>;

/** Risposta di `POST /api/vault/keys`. */
export const vaultCreateKeyResponseSchema = z.object({
  id: z.uuid(),
  status: vaultPersonKeyStatusSchema,
  createdAt: z.iso.datetime(),
});
export type VaultCreateKeyResponse = z.infer<typeof vaultCreateKeyResponseSchema>;

/**
 * Risposta di `GET /api/vault/keys/mine`: la propria chiave viva con i
 * sigilli (la privata CIFRATA, una per passkey), per aprirla nel browser.
 */
export const vaultMyKeyResponseSchema = z.object({
  id: z.uuid(),
  publicKey: z.string(),
  status: vaultPersonKeyStatusSchema,
  seals: z.array(vaultSealRefSchema.extend({ sealedPrivateKey: z.string() })),
});
export type VaultMyKeyResponse = z.infer<typeof vaultMyKeyResponseSchema>;

/**
 * Corpo di `POST /api/vault/recovery-key`: la nuova chiave pubblica di
 * recupero e la copia della chiave di OGNI credenziale cifrata per lei.
 */
export const vaultRecoveryKeyBodySchema = z.object({
  recoveryPublicKey: vaultPublicKeySchema,
  copies: z.array(z.object({ credentialId: z.uuid(), wrappedKey: envelopeSchema })).max(100_000),
});
export type VaultRecoveryKeyBody = z.infer<typeof vaultRecoveryKeyBodySchema>;
