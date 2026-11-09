// I link d'ingresso incollati (reset, invito), funzioni pure: `resetPassword.ts` le ri-esporta.

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
