import type { ServerSshAccess, SshVerification } from "../../data/model";

export type { VerifyOutcome } from "../../data/model";

/** L'unico utente SSH di un server: di sola lettura (area 8, F4b, Q3 = b). */
export const SSH_READ_USER = "stubwise-read";

/** I gruppi con cui l'utente legge il journal di sistema (F4b-3 = a). */
export const JOURNAL_GROUPS: readonly string[] = ["systemd-journal", "adm"];

/**
 * Lo stato dell'accesso SSH di un server, come lo legge chi guarda:
 * - `not_linked`: nessuna riga, o una riga senza chiavi mai revocata;
 * - `awaiting_command`: chiave generata (in `pending`), mai verificata;
 * - `verified`: la chiave in uso è verificata;
 * - `verify_failed`: l'ultima verifica non è entrata (`verifyFailure` dice perché);
 * - `privileged`: l'utente ha `sudo` o il gruppo `docker` — non è di sola
 *   lettura, quindi è un errore e l'accesso è spento;
 * - `revoked`: revocato, nessuna chiave.
 */
export type AccessState =
  | "not_linked"
  | "awaiting_command"
  | "verified"
  | "verify_failed"
  | "privileged"
  | "revoked";

/** Entrato, ma con più della lettura: `sudo` o il socket di Docker (il gruppo `docker` vale root). */
export const isPrivileged = (v: SshVerification): boolean =>
  v.login === "ok" && (v.sudo || v.docker);

const failed = (v: SshVerification) => v.login !== "ok";

export function accessState(a: ServerSshAccess | undefined): AccessState {
  if (!a) return "not_linked";
  const v = a.verification;
  if (a.key === null && a.pending === null) return a.revokedAt !== null ? "revoked" : "not_linked";
  // Un utente con più della lettura è un errore qualunque chiave riguardi:
  // spegne l'accesso finché una verifica non riesce. Vale anche per la
  // vecchia chiave durante una rigenerazione (`keyVerification`).
  if ((v && isPrivileged(v)) || (a.keyVerification && isPrivileged(a.keyVerification)))
    return "privileged";
  if (a.key === null) return v && v.ofPending && failed(v) ? "verify_failed" : "awaiting_command";
  // Una chiave sola (decisione del maintainer, 15 nov 2026): rigenerare
  // dimentica la vecchia, quindi una chiave in uso non ha mai una in attesa.
  return v && failed(v) ? "verify_failed" : "verified";
}

/** L'esito che vale per la chiave IN USO: durante una rigenerazione verificata male, quello di prima. */
function keyOutcome(a: ServerSshAccess): SshVerification | null {
  const v = a.verification;
  if (v === null || isPrivileged(v)) return null;
  const ofKey = v.ofPending && a.pending !== null ? a.keyVerification : v;
  return ofKey && ofKey.ok ? ofKey : null;
}

/**
 * Se l'accesso si può usare adesso. Mai senza una chiave verificata, mai
 * con un utente che ha più della lettura. Durante una rigenerazione vale la
 * vecchia chiave anche se la verifica della nuova è fallita, ma SOLO se lo
 * era prima di «Rigenera»: finché nessuno verifica la nuova vale l'esito
 * della vecchia (`verification`); dopo una verifica della nuova non
 * riuscita (`ofPending`), quell'esito sta in `keyVerification`. Senza
 * l'esito della vecchia, prudenza: non è usabile.
 */
export function accessUsable(a: ServerSshAccess | undefined): boolean {
  if (!a || a.key === null) return false;
  return keyOutcome(a) !== null;
}

/**
 * Se Claude può leggere il journal di sistema (`journalctl -p err`) adesso:
 * l'accesso è usabile e la verifica della chiave in uso ha trovato
 * l'utente in `systemd-journal` o `adm` (F4b-3 = a). Altrimenti la lettura
 * non c'è, e l'analisi dice che non può farla.
 */
export function journalReadable(a: ServerSshAccess | undefined): boolean {
  if (!a || a.key === null) return false;
  return keyOutcome(a)?.journal ?? false;
}

/** Perché l'ultima verifica non è entrata; `null` se è entrata (anche con `sudo`: è `privileged`). */
export function verifyFailure(
  a: ServerSshAccess | undefined,
): { login: "denied" | "unreachable"; reason: string | null } | null {
  const v = a?.verification;
  if (!v || v.login === "ok") return null;
  return { login: v.login, reason: v.reason };
}
