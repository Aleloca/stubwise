import { fakeSshPublicKey, SERVER_ACCESS } from "../seed/servers/access";
import { hashOf, seededRandom } from "../seed/servers/metrics";
import { now, onStoreReset } from "../store";
import type { SshAccessKind, SshPublicKey } from "../types";

// Le chiavi SSH PRIVATE dei server (anti-obiettivo 3): stanno SOLO qui, in
// una Map del modulo, cifrate, e non escono. Nessuna funzione le
// restituisce: chi le usa (analisi e correzione, simulate) chiede solo se ci
// sono (`hasKey`). Lo stato condiviso (`state.serverAccess`) tiene le sole
// chiavi pubbliche, quindi nessuna lettura, evento, notifica o comando
// mostrato le può contenere. Lo importano solo `access.ts`, `analysis.ts` e
// `fix.ts` (test architetturale in `data/architecture.test.ts`).
//
// SOLO PROTOTIPO: chiavi finte e «cifratura» finta (uno XOR con una chiave
// del modulo); nel motore sono generazione e cifratura vere.

type Slot = "current" | "pending";

/** `serverCode|kind|slot` → la privata cifrata. */
const vault = new Map<string, string>();
/** La generazione delle chiavi: il seme è la 1, ogni coppia nuova ne prende una. */
let generation = 1;

const slotKey = (serverCode: string, kind: SshAccessKind, slot: Slot) =>
  `${serverCode}|${kind}|${slot}`;

const VAULT_KEY = "stubwise-prototype-vault";

function encrypt(plain: string): string {
  let out = "";
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i) ^ VAULT_KEY.charCodeAt(i % VAULT_KEY.length);
    out += c.toString(16).padStart(2, "0");
  }
  return out;
}

function decrypt(cipher: string): string {
  let out = "";
  for (let i = 0; i < cipher.length; i += 2) {
    const c = parseInt(cipher.slice(i, i + 2), 16);
    out += String.fromCharCode(c ^ VAULT_KEY.charCodeAt((i / 2) % VAULT_KEY.length));
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Il corpo finto di una privata, deterministico per server, accesso e generazione. */
function privateBody(serverCode: string, kind: SshAccessKind, gen: number): string {
  const rnd = seededRandom(hashOf(`private|${serverCode}|${kind}|${gen}`));
  let out = "b3BlbnNzaC1rZXktdjEAAAAA";
  for (let i = 0; i < 152; i++) out += B64[Math.floor(rnd() * 64)];
  return out;
}

const privatePem = (body: string) =>
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;

function store(serverCode: string, kind: SshAccessKind, slot: Slot, gen: number): void {
  vault.set(
    slotKey(serverCode, kind, slot),
    encrypt(privatePem(privateBody(serverCode, kind, gen))),
  );
}

/**
 * Genera una coppia per l'accesso `kind` di `serverCode`: la privata resta
 * qui, cifrata (in `pending` se è di un collegamento o di una rigenerazione
 * non ancora verificati); esce solo la pubblica.
 */
export function storeKeyPair(
  serverCode: string,
  kind: SshAccessKind,
  pending: boolean,
): SshPublicKey {
  const gen = ++generation;
  store(serverCode, kind, pending ? "pending" : "current", gen);
  return fakeSshPublicKey(serverCode, kind, gen, now());
}

/** Le chiavi in attesa diventano quelle in uso; le vecchie si dimenticano. */
export function promotePending(serverCode: string): void {
  for (const kind of ["read", "fix"] as const) {
    const pending = vault.get(slotKey(serverCode, kind, "pending"));
    vault.delete(slotKey(serverCode, kind, "pending"));
    if (pending === undefined) vault.delete(slotKey(serverCode, kind, "current"));
    else vault.set(slotKey(serverCode, kind, "current"), pending);
  }
}

/** Dimentica ogni chiave del server (revoca, server tolto). */
export function forget(serverCode: string): void {
  for (const kind of ["read", "fix"] as const)
    for (const slot of ["current", "pending"] as const)
      vault.delete(slotKey(serverCode, kind, slot));
}

/** Se c'è la privata in uso dell'accesso `kind` (non quella in attesa). */
export function hasKey(serverCode: string, kind: SshAccessKind): boolean {
  return vault.has(slotKey(serverCode, kind, "current"));
}

/** Le private del seme, coerenti con le pubbliche di `SERVER_ACCESS` (generazione 1). */
export function seedSecrets(): void {
  vault.clear();
  generation = 1;
  for (const a of SERVER_ACCESS) {
    for (const kind of ["read", "fix"] as const) {
      if (a.keys) store(a.serverCode, kind, "current", 1);
      if (a.pending) store(a.serverCode, kind, "pending", 1);
    }
  }
}

seedSecrets();
onStoreReset(seedSecrets);

/**
 * SOLO TEST (RF 2): ogni valore segreto custodito adesso, in chiaro e
 * cifrato, per cercarlo in ciò che esce dalle letture. Nessun codice
 * dell'app lo chiama.
 */
export function __privateValuesForTest(): { slot: string; values: string[] }[] {
  return [...vault.entries()].map(([slot, cipher]) => {
    const pem = decrypt(cipher);
    const body = pem.split("\n")[1]!;
    return { slot, values: [pem, body, cipher] };
  });
}
