import type { ServerSshAccess, SshAccessKind, SshPublicKey } from "../../types";
import { daysFromToday } from "../dates";
import { hashOf, seededRandom } from "./metrics";

// Gli accessi SSH del seme. Solo chiavi PUBBLICHE: le private (finte)
// le scrive `data/servers/secrets.ts` (Task 4) al ripristino, e non escono
// da lì (anti-obiettivo 3). Nessuna riga = accesso non collegato.
//
// - SRV-1: verificato su entrambi; l'ultimo uso della lettura è l'analisi
//   dell'allarme di memoria, la correzione non è mai stata usata.
// - SRV-3: chiavi generate, comando mai eseguito («in attesa del comando»).
// - SRV-2 e SRV-4: non collegati.

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** L'intestazione vera di una chiave ed25519 in `authorized_keys`. */
const ED25519_PREFIX = "AAAAC3NzaC1lZDI1NTE5AAAAI";

function base64Of(seed: string, length: number): string {
  const rnd = seededRandom(hashOf(seed));
  let out = "";
  for (let i = 0; i < length; i++) out += B64[Math.floor(rnd() * 64)];
  return out;
}

/**
 * Una chiave pubblica finta ma nella forma vera (`ssh-ed25519 AAAA…
 * stubwise-read@SRV-1`), deterministica per server, accesso e generazione
 * (una rigenerazione ne dà una nuova).
 */
export function fakeSshPublicKey(
  serverCode: string,
  kind: SshAccessKind,
  generation: number,
  createdAt: string,
): SshPublicKey {
  const seed = `${serverCode}|${kind}|${generation}`;
  return {
    publicKey: `ssh-ed25519 ${ED25519_PREFIX}${base64Of(`key|${seed}`, 43)} stubwise-${kind}@${serverCode}`,
    fingerprint: `SHA256:${base64Of(`fp|${seed}`, 43)}`,
    createdAt,
  };
}

const pair = (serverCode: string, createdAt: string) => ({
  read: fakeSshPublicKey(serverCode, "read", 1, createdAt),
  fix: fakeSshPublicKey(serverCode, "fix", 1, createdAt),
});

export const SERVER_ACCESS: ServerSshAccess[] = [
  {
    serverCode: "SRV-1",
    keys: pair("SRV-1", at(20, "10:12")),
    pending: null,
    verification: { at: at(20, "10:31"), read: "ok", fix: "ok", reason: null, ofPending: false },
    keysVerification: null,
    lastUse: { read: { at: at(2, "18:07"), ref: { kind: "analysis", analysisId: "an-srv-1-1" } } },
    revokedAt: null,
  },
  {
    serverCode: "SRV-3",
    keys: null,
    pending: pair("SRV-3", at(1, "16:40")),
    verification: null,
    keysVerification: null,
    lastUse: {},
    revokedAt: null,
  },
];
