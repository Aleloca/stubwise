import type { GitProviderKind } from "./schemas/base-enums.js";

/**
 * L'AMBITO di un account git per il revisore predefinito (D1 del piano
 * `docs/plans/2026-10-01-default-reviewer-and-scopes.md`):
 * `(provider, workspace se Bitbucket altrimenti '')`.
 *
 * Funzione PURA, qui e non in `@stubwise/notifications`, perché la usano
 * anche i client: la risoluzione del revisore (`review-account.ts` di
 * notifications, che la importa e la ri-esporta) e la SPA, che chiede
 * conferma prima di sostituire il predefinito dello stesso ambito. Una copia
 * nel web sarebbe la terza versione della stessa regola.
 *
 * ⚠️ Gemello dell'indice `git_accounts_default_reviewer_scope_uq` della
 * migrazione 0082 (`packages/db/drizzle/0082_default_reviewer.sql`):
 * `(provider, CASE WHEN provider = 'bitbucket' THEN COALESCE(workspace, '') ELSE '' END)`.
 * Chi cambia l'uno cambia l'altro: `review-account.test.ts` (notifications)
 * verifica contro il Postgres vero che l'indice rifiuti due predefiniti
 * ESATTAMENTE quando questa funzione li mette nello stesso ambito. Su GitHub il
 * workspace non significa niente (come in `checkReviewAccount`), quindi non
 * entra nella chiave; su Bitbucket un workspace NULL vale come '' (la
 * COALESCE).
 *
 * La chiave è una stringa solo per confrontarla: il separatore `\u0000` non può
 * comparire in un nome di provider, quindi due ambiti diversi non collidono.
 */
export function reviewScopeKey(a: { provider: GitProviderKind; workspace: string | null }): string {
  const workspace = a.provider === "bitbucket" ? (a.workspace ?? "") : "";
  return `${a.provider}\u0000${workspace}`;
}
