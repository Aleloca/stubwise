import { gitAccounts, repositories, type Db } from "@stubwise/db";
import type { GitProviderKind } from "@stubwise/shared";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/**
 * Il revisore EFFETTIVO di una repository: UNA regola sola, che ogni
 * consumatore chiama (piano `docs/plans/2026-10-01-default-reviewer-and-scopes.md`,
 * D1-D2). I consumatori sono la pubblicazione della review e la fotografia dei
 * commenti nel worker, gli «account propri» del webhook di correzione, la
 * proiezione pubblica della repository e il ruolo di Validate: se uno di loro
 * rileggesse `review_git_account_id` da sé, la regola «una sola funzione»
 * sarebbe falsa e il predefinito varrebbe in un posto e non in un altro.
 */

/** Una riga intera di `git_accounts`: i consumatori ne vogliono credenziali e identità. */
export type GitAccountRow = typeof gitAccounts.$inferSelect;

/**
 * L'AMBITO di un account per il revisore predefinito (D1):
 * `(provider, workspace se Bitbucket altrimenti '')`.
 *
 * ⚠️ Gemello dell'indice `git_accounts_default_reviewer_scope_uq` della
 * migrazione 0082 (`packages/db/drizzle/0082_default_reviewer.sql`):
 * `(provider, CASE WHEN provider = 'bitbucket' THEN COALESCE(workspace, '') ELSE '' END)`.
 * Chi cambia l'uno cambia l'altro: `review-account.test.ts` verifica contro il
 * Postgres vero che l'indice rifiuti due predefiniti ESATTAMENTE quando questa
 * funzione li mette nello stesso ambito. Su GitHub il workspace non significa
 * niente (come in `checkReviewAccount`), quindi non entra nella chiave; su
 * Bitbucket un workspace NULL vale come '' (la COALESCE).
 *
 * La chiave è una stringa solo per confrontarla: il separatore `\u0000` non può
 * comparire in un nome di provider, quindi due ambiti diversi non collidono.
 */
export function reviewScopeKey(a: { provider: GitProviderKind; workspace: string | null }): string {
  const workspace = a.provider === "bitbucket" ? (a.workspace ?? "") : "";
  return `${a.provider}\u0000${workspace}`;
}

export type ReviewAccountSource = "explicit" | "default";

export interface ReviewAccountResolution<A> {
  /** Il revisore che Stubwise usa davvero su quella repository; null = nessuno (si commenta col principale). */
  effective: { account: A; source: ReviewAccountSource } | null;
  /**
   * Il predefinito del suo ambito che NON si applica perché è il principale
   * stesso (D3): esiste per dirlo all'utente, mai per usarlo.
   */
  skippedDefault: A | null;
}

/**
 * Regola pura (D2). `defaults` = TUTTI gli account con `is_default_reviewer`
 * (l'indice ne ammette al più uno per ambito).
 *
 * - un esplicito vince sempre, e il predefinito non si guarda nemmeno: se ce
 *   n'è uno uguale al principale non è «saltato», è irrilevante. La FK
 *   `SET NULL` e il CHECK `repositories_review_not_main_chk` garantiscono che
 *   l'esplicito esista e sia diverso dal principale;
 * - altrimenti il predefinito con lo stesso `reviewScopeKey` del principale,
 *   SCARTATO se è il principale stesso (un account non fa da revisore a sé);
 * - altrimenti nessuno.
 */
export function pickReviewAccount<A extends { id: string; provider: GitProviderKind; workspace: string | null }>(
  input: { main: A; explicit: A | null; defaults: readonly A[] },
): ReviewAccountResolution<A> {
  if (input.explicit !== null) {
    return { effective: { account: input.explicit, source: "explicit" }, skippedDefault: null };
  }
  const scope = reviewScopeKey(input.main);
  const def = input.defaults.find((d) => reviewScopeKey(d) === scope);
  if (!def) return { effective: null, skippedDefault: null };
  if (def.id === input.main.id) return { effective: null, skippedDefault: def };
  return { effective: { account: def, source: "default" }, skippedDefault: null };
}

/**
 * Batch: il revisore effettivo di N repository in DUE query — una per
 * repository + principale + esplicito, una per i predefiniti — mai 2N.
 * Le repository inesistenti sono ASSENTI dalla mappa.
 *
 * Restituisce righe `git_accounts` INTERE (credenziali cifrate e
 * `providerUserId` servono a chi pubblica e al webhook): non vanno mai
 * serializzate così come sono — le proiezioni pubbliche ne prendono solo
 * `id`/`name`.
 *
 * ⚠️ Una FINESTRA nota, accettata (D6): la regola si valuta AL MOMENTO della
 * chiamata, non al momento in cui una review è stata pubblicata. Se un admin
 * cambia il predefinito fra la pubblicazione di una review e l'arrivo del suo
 * webhook, quell'evento viene valutato con la configurazione NUOVA — e
 * l'account che ha pubblicato può non risultare più «proprio». È accettata
 * perché il cambio è raro, lo fa un admin, e nel caso peggiore parte UNA
 * correzione, sotto il tetto dei round e il budget. NON si chiude allargando
 * gli account propri a TUTTI i predefiniti dell'istanza: cambierebbe la
 * semantica — un account che su quella repository non è usato entrerebbe nel
 * fail-closed del webhook (un'identità non risolvibile di un account estraneo
 * scarterebbe ogni «Request changes» della repository) senza chiudere nessun
 * ciclo, perché il ciclo nasce solo dall'account con cui Stubwise pubblica su
 * QUELLA repository.
 */
export async function resolveReviewAccounts(
  db: Db,
  repositoryIds: readonly string[],
): Promise<Map<string, ReviewAccountResolution<GitAccountRow>>> {
  const result = new Map<string, ReviewAccountResolution<GitAccountRow>>();
  if (repositoryIds.length === 0) return result;

  const mainAccount = alias(gitAccounts, "main_account");
  const explicitAccount = alias(gitAccounts, "explicit_account");
  const [rows, defaults] = await Promise.all([
    db
      .select({ repositoryId: repositories.id, main: mainAccount, explicit: explicitAccount })
      .from(repositories)
      .innerJoin(mainAccount, eq(mainAccount.id, repositories.gitAccountId))
      .leftJoin(explicitAccount, eq(explicitAccount.id, repositories.reviewGitAccountId))
      .where(inArray(repositories.id, [...repositoryIds])),
    db.select().from(gitAccounts).where(eq(gitAccounts.isDefaultReviewer, true)),
  ]);

  for (const row of rows) {
    result.set(row.repositoryId, pickReviewAccount({ main: row.main, explicit: row.explicit, defaults }));
  }
  return result;
}

/**
 * Una repository: `resolveReviewAccounts(db, [id]).get(id)`; null se la
 * repository non esiste. Vale la stessa finestra documentata su
 * `resolveReviewAccounts` (D6).
 */
export async function resolveReviewAccount(
  db: Db,
  repositoryId: string,
): Promise<ReviewAccountResolution<GitAccountRow> | null> {
  return (await resolveReviewAccounts(db, [repositoryId])).get(repositoryId) ?? null;
}
