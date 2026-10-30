import { seedAccessState } from "../access/index";
import { hashOf, seededRandom } from "../seed/servers/metrics";
import { onInstanceEmptied, onStoreReset } from "../store";

// I segreti mostrati una volta (area 9a): token personali, link di reset
// della password e d'invito, segreto TOTP, codici di backup. Stanno SOLO
// qui, in una Map del modulo, fuori dallo stato condiviso: nessuna lettura,
// voce del registro o notifica li può contenere. Escono una volta, nel
// risultato della funzione che li crea (`storeSecret` restituisce il valore
// a lei, e a nessun altro); dopo resta solo la verifica (`matchSecret`,
// `consumeBackupCode`), che risponde sì o no.
//
// Lo importano solo `data/admin/*`, `data/me/*` e `data/auth/*`; nessuna
// lettura (`data/queries/*`, le letture del registro) e nessuna pagina lo
// raggiunge (test in `data/architecture.secrets.test.ts`). Come
// `servers/secrets.ts` dell'8b.
//
// SOLO PROTOTIPO: valori finti e deterministici, nessuna cifratura né hash
// (sul server i token e i codici di backup sono hash, il segreto TOTP è
// cifrato).

export type SecretKind = "pat" | "reset_link" | "totp_seed" | "backup_codes" | "invite_link";

interface Slot {
  kind: SecretKind;
  ownerId: string;
  value: string;
  /** `revealOnce` lo ha già dato. */
  revealed: boolean;
}

const vault = new Map<string, Slot>();
let counter = 0;

const ALNUM = "abcdefghijkmnpqrstuvwxyz23456789";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function chars(seed: string, alphabet: string, n: number): string {
  const rnd = seededRandom(hashOf(seed));
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

/** L'origine finta dell'istanza: i link e il comando di Claude Code la usano. */
export const INSTANCE_ORIGIN = "https://stubwise.example.test";
const INVITE_PREFIX = `${INSTANCE_ORIGIN}/register?invite=`;

/**
 * Il link d'invito di un token (la parte dopo `invite=`, quella della rotta
 * `/register/$token`); un link intero resta com'è. Per cercarlo con
 * `matchSecret`, senza mai leggere il valore custodito.
 */
export const inviteLinkOf = (tokenOrLink: string): string => {
  const value = tokenOrLink.trim();
  return value.startsWith(INVITE_PREFIX) ? value : `${INVITE_PREFIX}${value}`;
};

/** Il valore finto di un segreto nuovo, nella forma del web. */
function valueOf(kind: SecretKind, ownerId: string, n: number): string {
  const seed = `${kind}|${ownerId}|${n}`;
  switch (kind) {
    case "pat":
      return `stw_pat_${chars(seed, ALNUM, 32)}`;
    case "reset_link":
      return `${INSTANCE_ORIGIN}/reset-password?token=${chars(seed, ALNUM, 40)}`;
    case "invite_link":
      return `${INVITE_PREFIX}${chars(seed, ALNUM, 40)}`;
    case "totp_seed":
      return chars(seed, BASE32, 32);
    case "backup_codes":
      // 10 codici «xxxxx-xxxxx», uno per riga.
      return Array.from({ length: 10 }, (_, i) => {
        const c = chars(`${seed}|${i}`, ALNUM, 10);
        return `${c.slice(0, 5)}-${c.slice(5)}`;
      }).join("\n");
  }
}

/**
 * Crea e custodisce un segreto. Il valore lo riceve SOLO chi crea, per
 * restituirlo una volta nel proprio risultato (o metterlo dentro un comando,
 * un link); non va scritto nello stato, nel registro o in una notifica.
 */
export function storeSecret(kind: SecretKind, ownerId: string): { id: string; value: string } {
  const id = `sec-${++counter}`;
  const value = valueOf(kind, ownerId, counter);
  vault.set(id, { kind, ownerId, value, revealed: false });
  return { id, value };
}

/**
 * Il valore di un segreto, la prima volta e mai più: per chi lo crea in un
 * passo e lo mostra in quello dopo (il segreto TOTP dell'iscrizione).
 * Dopo, `null`, come per un id sconosciuto o dimenticato.
 */
export function revealOnce(id: string): string | null {
  const slot = vault.get(id);
  if (!slot || slot.revealed) return null;
  slot.revealed = true;
  return slot.value;
}

/** Dimentica un segreto (revoca, sostituzione, scadenza). */
export function forgetSecret(id: string): void {
  vault.delete(id);
}

/** Se `value` è un segreto custodito di quel tipo: di chi e con che id. Mai il valore. */
export function matchSecret(
  kind: SecretKind,
  value: string,
): { id: string; ownerId: string } | null {
  for (const [id, slot] of vault)
    if (slot.kind === kind && slot.value === value) return { id, ownerId: slot.ownerId };
  return null;
}

/** I segreti di un tipo di una persona (solo gli id): per sostituirli o dimenticarli. */
export function secretIdsOf(kind: SecretKind, ownerId: string): string[] {
  return [...vault.entries()]
    .filter(([, s]) => s.kind === kind && s.ownerId === ownerId)
    .map(([id]) => id);
}

/**
 * Un codice di backup di `ownerId`: se c'è, lo consuma (vale una volta) e
 * restituisce quanti ne restano; altrimenti `null`.
 */
export function consumeBackupCode(ownerId: string, code: string): number | null {
  const wanted = code.trim().toLowerCase();
  for (const [id, slot] of vault) {
    if (slot.kind !== "backup_codes" || slot.ownerId !== ownerId) continue;
    const codes = slot.value.split("\n");
    if (!codes.includes(wanted)) continue;
    const left = codes.filter((c) => c !== wanted);
    if (left.length) vault.set(id, { ...slot, value: left.join("\n") });
    else vault.delete(id);
    return left.length;
  }
  return null;
}

/**
 * Il seme: chi ha il secondo fattore ha i suoi 10 codici di backup (quelli
 * che vide una volta, quando li generò), coerenti con `backupCodesLeft`.
 * Nessuno li mostra più: servono solo a verificare.
 */
function seedSecrets(): void {
  vault.clear();
  counter = 0;
  for (const p of seedAccessState().people)
    if (p.secondFactor && p.secondFactor.backupCodesLeft > 0)
      storeSecret("backup_codes", p.personId);
}

seedSecrets();
onStoreReset(seedSecrets);
// L'istanza vuota (area 9a) non custodisce niente: nessuna persona, nessun segreto.
onInstanceEmptied(() => vault.clear());

/**
 * SOLO TEST (RF 2): ogni valore segreto custodito adesso — e ogni codice di
 * backup da solo — per cercarlo in ciò che esce dalle letture. Il test
 * architetturale vieta il nome fuori da qui (e dai test).
 */
export function __secretValuesForTest(): { id: string; kind: SecretKind; values: string[] }[] {
  return [...vault.entries()].map(([id, s]) => ({
    id,
    kind: s.kind,
    values: s.kind === "backup_codes" ? [s.value, ...s.value.split("\n")] : [s.value],
  }));
}
