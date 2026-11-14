import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { decrypt, encrypt, instanceSigningKeys, type Db } from "@stubwise/db";
import { canonicalCommandPayload, type ServerCommandPayload } from "@stubwise/shared";
import { isNull } from "drizzle-orm";

/**
 * La chiave Ed25519 d'istanza che firma i comandi verso gli agenti (area 8,
 * F4b, S2; docs/invariants/server-operations.md). Nasce al primo bisogno, UNA
 * attiva (indice unico parziale): con richieste insieme vince la prima e le
 * altre la rileggono. La privata è cifrata a riposo con la chiave delle
 * credenziali e si decifra SOLO per firmare: non esce mai da questo modulo
 * (nessuna risposta, nessun log). La pubblica (SPKI DER in base64, una riga)
 * è quella che l'agente fissa all'installazione.
 */

async function activeKey(db: Db, encryptionKey: Buffer) {
  const [row] = await db.select().from(instanceSigningKeys).where(isNull(instanceSigningKeys.retiredAt));
  if (row) return row;
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await db
    .insert(instanceSigningKeys)
    .values({ publicKey, privateKeyEncrypted: encrypt(privatePem, encryptionKey) })
    .onConflictDoNothing();
  const [created] = await db.select().from(instanceSigningKeys).where(isNull(instanceSigningKeys.retiredAt));
  if (!created) throw new Error("chiave di firma d'istanza non creata");
  return created;
}

/** La chiave pubblica d'istanza (la crea se manca). */
export async function commandPublicKey(db: Db, encryptionKey: Buffer): Promise<string> {
  return (await activeKey(db, encryptionKey)).publicKey;
}

/** La firma (base64) della serializzazione canonica del comando. */
export async function signCommand(db: Db, encryptionKey: Buffer, payload: ServerCommandPayload): Promise<string> {
  const row = await activeKey(db, encryptionKey);
  const privateKey = createPrivateKey(decrypt(row.privateKeyEncrypted, encryptionKey));
  return sign(null, Buffer.from(canonicalCommandPayload(payload)), privateKey).toString("base64");
}
