import { accessState } from "../access/index";
import { matchSecret, resetLinkOf } from "../admin/secrets";
import { MIN_PASSWORD_LENGTH } from "../me/account";
import { logSecurity } from "../me/securityLog";
import { gate, now, state } from "../store";

// Il link per reimpostare la password (area 9a, come
// `apps/web/src/routes/reset-password.tsx` e la rotta del server): lo crea
// chi gestisce le persone (`admin.createPasswordResetLink`), lo apre
// l'interessato. Vale un'ora e una volta sola; usato, la password cambia e
// TUTTE le sessioni della persona si chiudono (come `tx.delete(sessions)`
// del server). Come l'invito, il link si cerca con `matchSecret` senza
// leggerne il valore, e un link usato resta custodito per dire «già usato»:
// lo sa solo chi ha il link vero. Come la registrazione, il reset NON apre
// una sessione: dopo si entra dal login.

export type ResetLinkStatus = "valid" | "used" | "expired" | "invalid";

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: "used" | "expired" | "invalid" }
  | { ok: false; error: "invalid_input"; reason: "password" };

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
  if (link.usedAt) return "used";
  if (Date.parse(link.expiresAt) <= Date.parse(now())) return "expired";
  return "valid";
}

/** Cosa dice un link di reset: valido, già usato, scaduto, o niente. */
export async function getResetLink(token: string): Promise<{ status: ResetLinkStatus }> {
  await gate("auth.getResetLink");
  return { status: statusOf(linkOf(token)) };
}

/**
 * Imposta la password nuova con un link valido: il link non vale più, e ogni
 * sessione della persona si chiude. Senza sessione nuova: si entra dal login.
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
  logSecurity(link!.personId, "password_changed", null);
  return { ok: true };
}

/** Il token (la parte dopo `token=`) di un link di reset incollato intero. */
export const resetTokenOf = (link: string): string => link.split("token=").at(-1)!;
