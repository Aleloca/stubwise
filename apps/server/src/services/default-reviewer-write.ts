import { gitAccounts, type Db } from "@stubwise/db";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { changedFields, recordChange } from "./change-log.js";

/**
 * Il revisore predefinito, la SCRITTURA (lotto 6, voce 1): solo DB, nessuna
 * rete. La verifica sul provider sta in `default-reviewer-verify.ts` e gira
 * PRIMA, fuori dalla transazione (la rotta; per Claude il preflight del
 * catalogo, `claude-actions/preflight.ts`). La scrittura rifà comunque le
 * guardie di DB: l'account c'è ancora, sta nello stesso ambito verificato e,
 * se la verifica ha letto l'identità, le credenziali sono ancora quelle
 * (il blob cifrato fa da versione, come in `resolveProviderUserId`).
 */

type GitAccountRow = typeof gitAccounts.$inferSelect;
type Actor = { id: string; email: string };

/** Sentinella: l'account è sparito dentro la transazione, che va annullata. */
export class DefaultReviewerAccountGone extends Error {}
/** Sentinella: l'account ha cambiato AMBITO (o credenziali) fra la verifica e la scrittura. */
export class DefaultReviewerAccountChanged extends Error {}

/**
 * Le righe di `git_accounts` nello stesso AMBITO del revisore predefinito di
 * `row` (D1): gemello SQL di `reviewScopeKey` (`@stubwise/notifications`) e
 * dell'indice `git_accounts_default_reviewer_scope_uq` della 0082. Su
 * Bitbucket conta il workspace, con NULL uguale a ''; altrove solo il provider.
 */
export function sameReviewScope(row: Pick<GitAccountRow, "provider" | "workspace">): SQL {
  if (row.provider !== "bitbucket") return eq(gitAccounts.provider, row.provider);
  return and(eq(gitAccounts.provider, "bitbucket"), sql`coalesce(${gitAccounts.workspace}, '') = ${row.workspace ?? ""}`) as SQL;
}

export const gitAccountObject = (row: { id: string; name: string }) => ({ type: "git_account", id: row.id, label: row.name });

/**
 * Marca `row` come revisore predefinito del suo ambito, togliendo quello di
 * prima. `providerUserId` (dalla verifica) si salva solo se le credenziali
 * sono ancora quelle verificate. Lancia le sentinelle; il chiamante sta in
 * una transazione e la annulla.
 */
export async function writeDefaultReviewer(
  tx: Db,
  actor: Actor,
  row: GitAccountRow,
  providerUserId?: string | null,
): Promise<{ account: GitAccountRow; replaced: { id: string; name: string } | null }> {
  const replaced = await tx
    .update(gitAccounts)
    .set({ isDefaultReviewer: false })
    .where(and(sameReviewScope(row), eq(gitAccounts.isDefaultReviewer, true), ne(gitAccounts.id, row.id)))
    .returning({ id: gitAccounts.id, name: gitAccounts.name });
  // Marca solo se l'account sta ANCORA nell'ambito letto (e verificato): altrimenti si
  // toglierebbe il predefinito del vecchio ambito e si marcherebbe un account che ormai sta in un altro.
  const [account] = await tx
    .update(gitAccounts)
    .set({ isDefaultReviewer: true, ...(providerUserId ? { providerUserId } : {}) })
    .where(
      and(
        eq(gitAccounts.id, row.id),
        sameReviewScope(row),
        // L'identità letta vale solo per le credenziali verificate.
        ...(providerUserId ? [eq(gitAccounts.encryptedCredentials, row.encryptedCredentials)] : []),
      ),
    )
    .returning();
  if (!account) {
    const [exists] = await tx.select({ id: gitAccounts.id }).from(gitAccounts).where(eq(gitAccounts.id, row.id));
    throw exists ? new DefaultReviewerAccountChanged() : new DefaultReviewerAccountGone();
  }
  // Area 9, F3: come il prototipo, il predecessore e il nuovo per nome; un account che era già il predefinito non scrive niente.
  if (!row.isDefaultReviewer) {
    await recordChange(tx, { type: "git_account.default_reviewer_changed", actor, projectId: null, data: { object: gitAccountObject(account), before: replaced[0]?.name ?? null, after: account.name } });
  }
  return { account, replaced: replaced[0] ?? null };
}

/** Toglie il predefinito (idempotente); `undefined` se l'account non c'è. */
export async function clearDefaultReviewer(tx: Db, actor: Actor, id: string): Promise<GitAccountRow | undefined> {
  const [before] = await tx.select().from(gitAccounts).where(eq(gitAccounts.id, id)).for("update");
  if (!before) return undefined;
  const [after] = await tx.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, id)).returning();
  // Come il prototipo: togliere il predefinito è un `updated` sul campo.
  if (before.isDefaultReviewer) {
    await recordChange(tx, { type: "git_account.updated", actor, projectId: null, data: { object: gitAccountObject(after!), ...changedFields({ defaultReviewer: true }, { defaultReviewer: false })! } });
  }
  return after;
}
