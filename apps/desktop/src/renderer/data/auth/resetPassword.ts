import { accessState } from "../access/index";
import { forgetSecret, matchSecret, resetLinkOf, secretIdsOf } from "../admin/secrets";
import { MIN_PASSWORD_LENGTH } from "../me/account";
import { logSecurity } from "../me/securityLog";
import { getSessionPersonId } from "../session";
import { gate, now, state } from "../store";

// Il link per reimpostare la password (area 9a, come
// `apps/web/src/routes/reset-password.tsx` e la rotta del server): lo crea
// chi gestisce le persone (`admin.createPasswordResetLink`), lo apre
// l'interessato. Vale un'ora e una volta sola; usato, la password cambia e
// TUTTE le sessioni della persona si chiudono (come `tx.delete(sessions)`
// del server), compresa questa se è sua: l'app esce. Come l'invito, il link
// si cerca con `matchSecret` senza leggerne il valore. Usato e scaduto
// rispondono uguale («spent»), come la 410 del server, che non fa da
// oracolo; un link sconosciuto, sostituito o dimenticato è «invalid». Come la
// registrazione, il reset NON apre una sessione: dopo si entra dal login.
//
// Un link aperto si DIMENTICA (`forgetResetLinksOf`) quando ne nasce un altro,
// quando la persona cambia da sé la password (come `/me/password` del
// server) e quando viene disattivata: riattivarla non lo rende di nuovo buono.

export type ResetLinkStatus = "valid" | "spent" | "invalid";

export type ResetPasswordResult =
  /** `signedOutHere`: la sessione di questa app era della persona, ed è chiusa anche lei. */
  | { ok: true; signedOutHere: boolean }
  | { ok: false; error: "spent" | "invalid" }
  | { ok: false; error: "invalid_input"; reason: "password" };

/** Il link aperto di una persona, se c'è, smette di valere: chi lo apre legge «invalid». */
export function forgetResetLinksOf(personId: string): void {
  for (const id of secretIdsOf("reset_link", personId)) forgetSecret(id);
  state.resetLinks = state.resetLinks.filter((l) => l.personId !== personId);
}

function linkOf(token: string) {
  const match = matchSecret("reset_link", resetLinkOf(token));
  if (!match) return null;
  return state.resetLinks.find((l) => l.secretId === match.id) ?? null;
}

function statusOf(link: ReturnType<typeof linkOf>): ResetLinkStatus {
  if (!link) return "invalid";
  // Una persona disattivata dopo la creazione del link non rientra da qui.
  const person = accessState().people.find((p) => p.personId === link.personId);
  if (person?.status !== "active") return "invalid";
  if (link.usedAt) return "spent";
  if (Date.parse(link.expiresAt) <= Date.parse(now())) return "spent";
  return "valid";
}

/** Cosa dice un link di reset: valido, non più buono (usato o scaduto), o niente. */
export async function getResetLink(token: string): Promise<{ status: ResetLinkStatus }> {
  await gate("auth.getResetLink");
  return { status: statusOf(linkOf(token)) };
}

/**
 * Imposta la password nuova con un link valido: il link non vale più, e ogni
 * sessione della persona si chiude. Senza sessione nuova: si entra dal login.
 * Se chi l'apre è dentro come quella persona, esce anche da qui.
 */
export async function resetPassword(
  token: string,
  input: { password: string },
): Promise<ResetPasswordResult> {
  await gate("auth.resetPassword");
  const link = linkOf(token);
  const status = statusOf(link);
  if (status !== "valid") return { ok: false, error: status };
  if (input.password.length < MIN_PASSWORD_LENGTH)
    return { ok: false, error: "invalid_input", reason: "password" };
  state.passwords.set(link!.personId, input.password);
  link!.usedAt = now();
  state.sessions = state.sessions.filter((s) => s.personId !== link!.personId);
  const signedOutHere = state.entry.signedIn && getSessionPersonId() === link!.personId;
  if (signedOutHere) state.entry = { signedIn: false, partial: null };
  logSecurity(link!.personId, "password_changed", null);
  return { ok: true, signedOutHere };
}

/** Il token (la parte dopo `token=`) di un link di reset incollato intero. */
export const resetTokenOf = (link: string): string => link.split("token=").at(-1)!;

/**
 * SOLO PROTOTIPO, il campo «Paste an invite or reset link» del login: dove
 * porta un link incollato. Un link di reset ha `token=` (o la sua rotta), un
 * invito `invite=`; un token nudo si prova come invito, che se non lo
 * riconosce dice «non valido» senza nomi. `null` per un campo vuoto.
 */
export function entryLinkOf(link: string): { kind: "invite" | "reset"; token: string } | null {
  const clean = link.trim();
  if (!clean) return null;
  const reset = clean.includes("token=") || clean.includes("reset-password");
  const token = (
    reset ? resetTokenOf(clean).split("reset-password/").at(-1)! : clean.split("invite=").at(-1)!
  ).trim();
  return token ? { kind: reset ? "reset" : "invite", token } : null;
}
