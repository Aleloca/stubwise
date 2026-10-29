import type { ServerSshAccess, SshAccessKind } from "../../data/model";

export type { VerifyOutcome } from "../../data/model";

/**
 * Lo stato dei due accessi SSH di un server (lettura e correzione), come lo
 * legge chi guarda:
 * - `not_linked`: nessuna riga, o una riga senza chiavi mai revocata;
 * - `awaiting_command`: chiavi generate (in `pending`), mai verificate;
 * - `verified`: le chiavi in uso sono verificate;
 * - `verify_failed`: l'ultima verifica è fallita (`verifyFailure` dice quale e perché);
 * - `read_writes`: l'accesso di lettura può scrivere — un errore, spegne entrambi;
 * - `regenerating`: chiavi nuove in `pending`, le vecchie restano in uso;
 * - `revoked`: revocato, nessuna chiave.
 */
export type AccessState =
  | "not_linked"
  | "awaiting_command"
  | "verified"
  | "verify_failed"
  | "read_writes"
  | "regenerating"
  | "revoked";

type Verification = NonNullable<ServerSshAccess["verification"]>;

const failed = (v: Verification) => v.read === "failed" || v.fix === "failed";

export function accessState(a: ServerSshAccess | undefined): AccessState {
  if (!a) return "not_linked";
  const v = a.verification;
  if (a.keys === null && a.pending === null) return a.revokedAt !== null ? "revoked" : "not_linked";
  // Una lettura che scrive è un errore qualunque chiave riguardi (scelta del
  // piano): spegne entrambi gli accessi finché una verifica non riesce. Vale
  // anche per le vecchie chiavi durante una rigenerazione (`keysVerification`).
  if (v?.read === "writes" || a.keysVerification?.read === "writes") return "read_writes";
  if (a.keys === null) return v && v.ofPending && failed(v) ? "verify_failed" : "awaiting_command";
  if (a.pending !== null) return v && v.ofPending && failed(v) ? "verify_failed" : "regenerating";
  return v && failed(v) ? "verify_failed" : "verified";
}

/**
 * Se l'accesso `kind` si può usare adesso. Mai senza chiavi verificate, mai
 * se la lettura scrive (nessuno dei due). Durante una rigenerazione valgono
 * le vecchie chiavi anche se la verifica delle nuove è fallita, ma SOLO se
 * lo erano prima di «Rigenera»: finché nessuno verifica le nuove vale
 * l'esito delle vecchie (`verification` di `keys`); dopo una verifica delle
 * nuove non riuscita (`ofPending`), quell'esito sta in `keysVerification`.
 * Così una `fix` già fallita non torna usabile rigenerando. Senza l'esito
 * delle vecchie, prudenza: niente è usabile.
 */
export function accessUsable(a: ServerSshAccess | undefined, kind: SshAccessKind): boolean {
  if (!a || a.keys === null) return false;
  const v = a.verification;
  if (v === null || v.read === "writes") return false;
  const ofKeys = v.ofPending && a.pending !== null ? a.keysVerification : v;
  if (ofKeys === null || ofKeys.read === "writes") return false;
  return ofKeys[kind] === "ok";
}

/** Quale accesso non ha passato l'ultima verifica, e perché; `null` se nessuno. */
export function verifyFailure(
  a: ServerSshAccess | undefined,
): { read: boolean; fix: boolean; reason: string | null } | null {
  const v = a?.verification;
  if (!v || !failed(v)) return null;
  return { read: v.read === "failed", fix: v.fix === "failed", reason: v.reason };
}
