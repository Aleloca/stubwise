import type { ServerSshAccess, SshPublicKey } from "../../types";
import { daysFromToday } from "../dates";
import { hashOf, seededRandom } from "./metrics";

// Gli accessi SSH del seme: uno per server, di sola lettura
// (`stubwise-read`, area 8, F4b). Solo chiavi PUBBLICHE: le private (finte)
// le scrive `data/servers/secrets.ts` al ripristino, e non escono da lì
// (anti-obiettivo 3). Nessuna riga = accesso non collegato.
//
// - SRV-1: verificato (niente `sudo` né `docker`, legge il journal col
//   gruppo `systemd-journal`); l'ultimo uso è l'analisi dell'allarme di
//   memoria.
// - SRV-3: chiave generata, comando mai eseguito («in attesa del comando»).
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
 * stubwise-read@SRV-1`), deterministica per server e generazione (una
 * rigenerazione ne dà una nuova).
 */
export function fakeSshPublicKey(
  serverCode: string,
  generation: number,
  createdAt: string,
): SshPublicKey {
  const seed = `${serverCode}|read|${generation}`;
  return {
    publicKey: `ssh-ed25519 ${ED25519_PREFIX}${base64Of(`key|${seed}`, 43)} stubwise-read@${serverCode}`,
    fingerprint: `SHA256:${base64Of(`fp|${seed}`, 43)}`,
    createdAt,
  };
}

export const SERVER_ACCESS: ServerSshAccess[] = [
  {
    serverCode: "SRV-1",
    key: fakeSshPublicKey("SRV-1", 1, at(20, "10:12")),
    pending: null,
    verification: {
      at: at(20, "10:31"),
      login: "ok",
      groups: ["stubwise-read", "systemd-journal"],
      sudo: false,
      docker: false,
      journal: true,
      ok: true,
      reason: null,
      ofPending: false,
    },
    keyVerification: null,
    lastUse: { at: at(2, "18:07"), ref: { kind: "analysis", analysisId: "an-srv-1-1" } },
    revokedAt: null,
  },
  {
    serverCode: "SRV-3",
    key: null,
    pending: fakeSshPublicKey("SRV-3", 1, at(1, "16:40")),
    verification: null,
    keyVerification: null,
    lastUse: null,
    revokedAt: null,
  },
];
