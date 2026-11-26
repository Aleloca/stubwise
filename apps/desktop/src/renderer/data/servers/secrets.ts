import { fakeSshPublicKey, SERVER_ACCESS } from "../seed/servers/access";
import { hashOf, seededRandom } from "../seed/servers/metrics";
import { now, onStoreReset } from "../store";
import type { SshPublicKey } from "../types";

// Le chiavi SSH PRIVATE dei server (anti-obiettivo 3): una per server,
// quella dell'accesso di sola lettura (`stubwise-read`, area 8, F4b). Stanno
// SOLO qui, in una Map del modulo, cifrate, e non escono. Nessuna funzione
// le restituisce: chi le usa (l'analisi, simulata) chiede solo se c'è
// (`hasKey`). Lo stato condiviso (`state.serverAccess`) tiene le sole
// chiavi pubbliche, quindi nessuna lettura, evento, notifica o comando
// mostrato le può contenere. Lo importano solo `access.ts` e `analysis.ts`
// (test architetturale in `data/architecture.test.ts`).
//
// SOLO PROTOTIPO: chiavi finte e «cifratura» finta (uno XOR con una chiave
// del modulo); nel motore sono generazione e cifratura vere.

type Slot = "current" | "pending";

/** `serverCode|slot` → la privata cifrata. */
const vault = new Map<string, string>();
/** La generazione delle chiavi: il seme è la 1, ogni coppia nuova ne prende una. */
let generation = 1;

const slotKey = (serverCode: string, slot: Slot) => `${serverCode}|${slot}`;

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

/** Il corpo finto di una privata, deterministico per server e generazione. */
function privateBody(serverCode: string, gen: number): string {
  const rnd = seededRandom(hashOf(`private|${serverCode}|read|${gen}`));
  let out = "b3BlbnNzaC1rZXktdjEAAAAA";
  for (let i = 0; i < 152; i++) out += B64[Math.floor(rnd() * 64)];
  return out;
}

const privatePem = (body: string) =>
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;

function store(serverCode: string, slot: Slot, gen: number): void {
  vault.set(slotKey(serverCode, slot), encrypt(privatePem(privateBody(serverCode, gen))));
}

/**
 * Genera la coppia dell'accesso di `serverCode`: la privata resta qui,
 * cifrata (in `pending` se è di un collegamento o di una rigenerazione non
 * ancora verificati); esce solo la pubblica.
 */
export function storeKeyPair(serverCode: string, pending: boolean): SshPublicKey {
  const gen = ++generation;
  store(serverCode, pending ? "pending" : "current", gen);
  return fakeSshPublicKey(serverCode, gen, now());
}

/** La chiave in attesa diventa quella in uso; la vecchia si dimentica. */
export function promotePending(serverCode: string): void {
  const pending = vault.get(slotKey(serverCode, "pending"));
  vault.delete(slotKey(serverCode, "pending"));
  if (pending === undefined) vault.delete(slotKey(serverCode, "current"));
  else vault.set(slotKey(serverCode, "current"), pending);
}

/** Dimentica ogni chiave del server (revoca, server tolto). */
export function forget(serverCode: string): void {
  for (const slot of ["current", "pending"] as const) vault.delete(slotKey(serverCode, slot));
}

/** Se c'è la privata in uso (non quella in attesa). */
export function hasKey(serverCode: string): boolean {
  return vault.has(slotKey(serverCode, "current"));
}

/** Le private del seme, coerenti con le pubbliche di `SERVER_ACCESS` (generazione 1). */
export function seedSecrets(): void {
  vault.clear();
  generation = 1;
  for (const a of SERVER_ACCESS) {
    if (a.key) store(a.serverCode, "current", 1);
    if (a.pending) store(a.serverCode, "pending", 1);
  }
}

seedSecrets();
onStoreReset(seedSecrets);

/**
 * SOLO TEST (RF 2): ogni valore segreto custodito adesso, in chiaro e
 * cifrato, per cercarlo in ciò che esce dalle letture. È l'UNICA eccezione
 * all'anti-obiettivo 3, e solo nel prototipo: il test architetturale vieta
 * il nome fuori da qui (e dai test). Nel motore non va copiata.
 */
export function __privateValuesForTest(): { slot: string; values: string[] }[] {
  return [...vault.entries()].map(([slot, cipher]) => {
    const pem = decrypt(cipher);
    const body = pem.split("\n")[1]!;
    return { slot, values: [pem, body, cipher] };
  });
}
