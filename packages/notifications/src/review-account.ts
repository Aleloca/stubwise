import { gitAccounts, repositories } from "@stubwise/db";
import type { GitProviderKind } from "@stubwise/shared";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "./dispatch.js";

/**
 * Il revisore EFFETTIVO di una repository: UNA regola sola, che ogni
 * consumatore chiama (piano `docs/plans/2026-10-01-default-reviewer-and-scopes.md`,
 * D1-D2). I consumatori sono la pubblicazione della review e la fotografia dei
 * commenti nel worker, gli «account propri» del webhook di correzione, la
 * proiezione pubblica della repository e il ruolo di Validate: se uno di loro
 * rileggesse `review_git_account_id` da sé, la regola «una sola funzione»
 * sarebbe falsa e il predefinito varrebbe in un posto e non in un altro.
 */

/**
 * Una riga INTERA di `git_accounts`, blob delle credenziali compreso: la
 * restituiscono solo le varianti `…WithCredentials`, per chi si deve
 * autenticare sulla piattaforma.
 */
export type GitAccountRow = typeof gitAccounts.$inferSelect;

/**
 * Le colonne della PROIEZIONE che la variante di default restituisce: tutto
 * ciò che serve a server, form e confronto delle identità, MAI
 * `encryptedCredentials`. Un elenco esplicito (non «tutto tranne») così una
 * colonna nuova di `git_accounts` non entra da sola: la si aggiunge qui di
 * proposito. Un test fissa queste chiavi contro gli oggetti restituiti.
 */
export const REVIEW_ACCOUNT_VIEW_KEYS = [
  "id",
  "name",
  "provider",
  "workspace",
  "providerUserId",
  "isDefaultReviewer",
] as const satisfies readonly (keyof GitAccountRow)[];

type ViewKey = (typeof REVIEW_ACCOUNT_VIEW_KEYS)[number];

/** Un account visto dalla risoluzione del revisore, senza credenziali. */
export type ReviewAccountView = Pick<GitAccountRow, ViewKey>;

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
 * - un esplicito DIVERSO dal principale vince sempre, e il predefinito non si
 *   guarda nemmeno: se ce n'è uno uguale al principale non è «saltato», è
 *   irrilevante. Che l'esplicito esista e sia diverso dal principale è
 *   garantito dalla FK `SET NULL` e dal CHECK `repositories_review_not_main_chk`,
 *   e comunque riverificato qui: un esplicito con lo stesso id del principale
 *   vale come assente, e si prosegue con la regola del predefinito. NON
 *   riverifica invece provider e workspace dell'esplicito: è compito di
 *   `checkReviewAccount` quando la colonna viene scritta;
 * - altrimenti il predefinito con lo stesso `reviewScopeKey` del principale,
 *   SCARTATO se è il principale stesso (un account non fa da revisore a sé);
 * - altrimenti nessuno.
 */
export function pickReviewAccount<A extends { id: string; provider: GitProviderKind; workspace: string | null }>(
  input: { main: A; explicit: A | null; defaults: readonly A[] },
): ReviewAccountResolution<A> {
  if (input.explicit !== null && input.explicit.id !== input.main.id) {
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
 * Restituisce una PROIEZIONE degli account ({@link ReviewAccountView}: id,
 * nome, provider, workspace, identità in cache, flag del predefinito), MAI il
 * blob delle credenziali: è la variante per il server, il form e il confronto
 * delle identità, e un serializzatore distratto non può ricevere quello che
 * non c'è. Chi si deve AUTENTICARE con l'account usa
 * {@link resolveReviewAccountsWithCredentials}, col nome che lo dice.
 *
 * `db` accetta anche una transazione: il `Promise.all` resta, perché con
 * postgres-js le due query si pipelinano sulla stessa connessione della tx.
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
 * QUELLA repository. Vale identica per la variante `WithCredentials`.
 */
export async function resolveReviewAccounts(
  db: DbOrTx,
  repositoryIds: readonly string[],
): Promise<Map<string, ReviewAccountResolution<ReviewAccountView>>> {
  const result = new Map<string, ReviewAccountResolution<ReviewAccountView>>();
  if (repositoryIds.length === 0) return result;

  const mainAccount = alias(gitAccounts, "main_account");
  const explicitAccount = alias(gitAccounts, "explicit_account");
  // Le colonne di REVIEW_ACCOUNT_VIEW_KEYS, scritte tre volte (principale,
  // esplicito, predefiniti): un helper generico sugli alias perde i tipi delle
  // colonne. `satisfies` le tiene allineate all'elenco.
  const [rows, defaults] = await Promise.all([
    db
      .select({
        repositoryId: repositories.id,
        main: {
          id: mainAccount.id,
          name: mainAccount.name,
          provider: mainAccount.provider,
          workspace: mainAccount.workspace,
          providerUserId: mainAccount.providerUserId,
          isDefaultReviewer: mainAccount.isDefaultReviewer,
        } satisfies Record<ViewKey, unknown>,
        explicit: {
          id: explicitAccount.id,
          name: explicitAccount.name,
          provider: explicitAccount.provider,
          workspace: explicitAccount.workspace,
          providerUserId: explicitAccount.providerUserId,
          isDefaultReviewer: explicitAccount.isDefaultReviewer,
        } satisfies Record<ViewKey, unknown>,
      })
      .from(repositories)
      .innerJoin(mainAccount, eq(mainAccount.id, repositories.gitAccountId))
      .leftJoin(explicitAccount, eq(explicitAccount.id, repositories.reviewGitAccountId))
      .where(inArray(repositories.id, [...repositoryIds])),
    db
      .select({
        id: gitAccounts.id,
        name: gitAccounts.name,
        provider: gitAccounts.provider,
        workspace: gitAccounts.workspace,
        providerUserId: gitAccounts.providerUserId,
        isDefaultReviewer: gitAccounts.isDefaultReviewer,
      } satisfies Record<ViewKey, unknown>)
      .from(gitAccounts)
      .where(eq(gitAccounts.isDefaultReviewer, true)),
  ]);

  for (const row of rows) {
    result.set(row.repositoryId, pickReviewAccount({ main: row.main, explicit: row.explicit, defaults }));
  }
  return result;
}

/**
 * Come {@link resolveReviewAccounts}, ma con le righe `git_accounts` INTERE,
 * blob delle credenziali compreso. SOLO per chi si deve autenticare con
 * l'account: il worker che pubblica il verdetto, e chi deve risolvere
 * un'identità non ancora salvata (`resolveProviderUserId` decifra le
 * credenziali per chiedere `/user`). Il risultato non va mai serializzato così
 * com'è. Stessa regola, stesse due query, stessa finestra (D6).
 */
export async function resolveReviewAccountsWithCredentials(
  db: DbOrTx,
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
 * repository non esiste. Proiezione senza credenziali; vale la stessa
 * finestra documentata su `resolveReviewAccounts` (D6).
 */
export async function resolveReviewAccount(
  db: DbOrTx,
  repositoryId: string,
): Promise<ReviewAccountResolution<ReviewAccountView> | null> {
  return (await resolveReviewAccounts(db, [repositoryId])).get(repositoryId) ?? null;
}

/**
 * Una repository, con le credenziali: vedi
 * {@link resolveReviewAccountsWithCredentials} per chi la può usare.
 */
export async function resolveReviewAccountWithCredentials(
  db: DbOrTx,
  repositoryId: string,
): Promise<ReviewAccountResolution<GitAccountRow> | null> {
  return (await resolveReviewAccountsWithCredentials(db, [repositoryId])).get(repositoryId) ?? null;
}
