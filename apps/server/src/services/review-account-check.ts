import { BITBUCKET_REVIEWER_SCOPES, getProvider, type CredentialCheckPurpose } from "@stubwise/git";
import { gitAccounts } from "@stubwise/db";
import { decryptGitCredentials, resolveProviderUserId } from "@stubwise/notifications";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { fetchPlatformIdentity } from "./platform-identity.js";

/**
 * Validazione di un account REVISORE su una repository, condivisa da due rotte
 * (1 ott 2026, piano P1-7): il form della repository (`routes/repositories.ts`,
 * revisore esplicito e avviso sul predefinito) e l'impostazione del revisore
 * predefinito (`routes/git-accounts.ts`, avvisi per repository). Estratta
 * senza cambi di comportamento: una regola sola, due chiamanti.
 */

type GitAccountRow = typeof gitAccounts.$inferSelect;

/** I controlli di `validateCredentials` che contano per un REVISORE: vedi il commento in `checkReviewAccount`. */
const REVIEWER_CHECK_PURPOSES: ReadonlySet<CredentialCheckPurpose | undefined> = new Set<CredentialCheckPurpose>([
  "rest",
  "scopes",
]);

export type ReviewAccountCheck =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 422; code: string; message: string };

/** Scrive nel log PERCHÉ un'identità non si risolve: il messaggio del provider, mai il token. */
export function logIdentityError(app: FastifyInstance, gitAccountId: string, what: string) {
  return (err: unknown) =>
    app.log.warn({ gitAccountId, err: err instanceof Error ? err.message : String(err) }, what);
}

/**
 * Validazione dell'account revisore (design §8). I controlli LOCALI —
 * esistenza, account diverso, stesso provider, stesso workspace Bitbucket —
 * sempre; quelli di RETE solo quando il revisore viene scelto adesso
 * o quando cambia DOVE va verificato (`verifyRemote`): l'accesso REST alle
 * pull request (`purpose: "rest"`) e, su Bitbucket, gli scope del revisore
 * sul TOKEN (`purpose: "scopes"`, «non verificabile» e quindi non bloccante
 * se l'header degli scope manca o è vuoto, o la credenziale non è un API
 * token) — push, merge e webhook il revisore non li usa — e identità sulla
 * piattaforma,
 * RI-risolta (non dalla cache: il salvataggio è il momento in cui l'admin
 * deve sapere se funziona) e diversa da quella del principale. Anche
 * l'identità del principale si risolve qui: serve al confronto, e senza il
 * webhook scarterebbe ogni "Request changes" (fail-closed, §5). Senza
 * revisore, la stessa condizione è solo un avviso (`mainIdentityWarnings`).
 *
 * Gli scope dicono cosa può fare il TOKEN, non il permesso dell'utente: il
 * permesso di scrittura sul repository non è verificabile su Bitbucket dopo
 * CHANGE-2770; un revisore in sola lettura si scopre al primo verdetto, con
 * "Verdetto non apposto".
 */
export async function checkReviewAccount(
  app: FastifyInstance,
  input: {
    mainAccount: GitAccountRow;
    reviewGitAccountId: string;
    repoUrl: string;
    defaultBranch: string;
    verifyRemote: boolean;
  },
): Promise<ReviewAccountCheck> {
  const { mainAccount } = input;
  if (input.reviewGitAccountId === mainAccount.id) {
    return {
      ok: false,
      status: 400,
      code: "review_account_same_as_main",
      message: "The review account must differ from the repository's main account",
    };
  }
  const [review] = await app.db
    .select()
    .from(gitAccounts)
    .where(eq(gitAccounts.id, input.reviewGitAccountId));
  if (!review) {
    return { ok: false, status: 404, code: "review_git_account_not_found", message: "Review git account not found" };
  }
  if (review.provider !== mainAccount.provider) {
    return {
      ok: false,
      status: 400,
      code: "review_account_provider_mismatch",
      message: "The review account must be on the same provider as the main account",
    };
  }
  if (review.provider === "bitbucket" && review.workspace !== mainAccount.workspace) {
    return {
      ok: false,
      status: 400,
      code: "review_account_workspace_mismatch",
      message: "The review account must be in the same Bitbucket workspace as the main account",
    };
  }
  if (!input.verifyRemote) return { ok: true };

  const credentials = decryptGitCredentials(review.encryptedCredentials, app.encryptionKey);
  if (!credentials) {
    return {
      ok: false,
      status: 400,
      // Codice suo: il 400 generico della rotta parla dell'account
      // PRINCIPALE (configure-webhook), qui è il revisore a non decifrarsi.
      code: "review_credentials_undecryptable",
      message: "The review account's credentials cannot be decrypted: re-enter them in the git account",
    };
  }
  // Su Bitbucket si chiedono anche gli SCOPE DEL REVISORE, letti dalla
  // risposta della REST delle PR che `validateCredentials` riceve già (nessuna
  // chiamata in più; GitHub ignora l'opzione). Verificano il TOKEN, non il
  // permesso dell'utente sul repository: il permesso di scrittura sul
  // repository non è verificabile su Bitbucket dopo CHANGE-2770; un revisore
  // in sola lettura si scopre al primo verdetto, con "Verdetto non apposto".
  // Header assente/vuoto o credenziale non `api_token` (app password): ok
  // «non verificabile», come in Validate — non blocca.
  const checks = await getProvider(review.provider).validateCredentials(
    { repoUrl: input.repoUrl, defaultBranch: input.defaultBranch, credentials },
    { fetchImpl: fetch, requiredScopes: BITBUCKET_REVIEWER_SCOPES },
  );
  // Per il revisore contano SOLO l'accesso REST alle pull request e (su
  // Bitbucket) gli scope del token, più l'identità controllata qui sotto. Il revisore
  // non pusha, non mergia e non gestisce i webhook: push, merge e webhook
  // restano FUORI per costruzione. Una ALLOW-LIST e non una lista di
  // esclusioni (1 ott 2026): con l'esclusione del solo `webhook`, il check
  // `merge` di Bitbucket — sempre KO dopo CHANGE-2770 — e il `push` — KO per
  // un revisore senza username Bitbucket, che con un API token non serve a
  // nient'altro — facevano fallire OGNI repository. Un check nuovo deve
  // entrare qui di proposito, mai per default. Si sceglie per SCOPO, mai per
  // etichetta: le etichette sono testo per le persone e possono cambiare.
  // Su GitHub il `rest` porta anche `failure: "no_write_permission"` da
  // `permissions.push`: resta il controllo giusto, perché approvare o
  // chiedere modifiche vuole la scrittura sulla repository.
  const failed = checks.filter((check) => REVIEWER_CHECK_PURPOSES.has(check.purpose) && !check.ok);
  // Il caso più probabile, e il più fraintendibile dal solo dettaglio del
  // provider: il token vede la repository ma non ci può scrivere. Senza
  // scrittura né approve né "Request changes" passano: lo si dice in chiaro.
  if (failed.some((check) => check.failure === "no_write_permission")) {
    return {
      ok: false,
      status: 422,
      code: "review_account_no_write_permission",
      message: "The review account has no write permission on the repository",
    };
  }
  if (failed.length > 0) {
    // Uno scope mancante si dice per quello che è: del TOKEN, non un permesso
    // dell'utente sul repository (che su Bitbucket non è verificabile).
    const tokenScopesNote = failed.some((check) => check.purpose === "scopes")
      ? " (these are the token's scopes, not the user's permission on the repository)"
      : "";
    return {
      ok: false,
      status: 422,
      code: "review_account_invalid",
      // Il dettaglio dei controlli (dal provider) è la parte utile: dice
      // quale permesso o scope manca.
      message: failed.map((check) => `${check.name}: ${check.detail}`).join("; ") + tokenScopesNote,
    };
  }
  // Su Bitbucket leggere "chi sono" vuole lo scope `read:user:bitbucket`: un
  // token creato prima del ciclo di correzione risponde 403, e va detto QUI —
  // al webhook sarebbe un "Request changes" scartato (fail-closed), spiegato
  // solo a cose fatte sul ticket (D2). È un SUGGERIMENTO, non la diagnosi: il
  // motivo vero (401, 403, rate limit…) lo scrive onError nel log.
  const scopeHint =
    review.provider === "bitbucket" ? " (on Bitbucket, check that the token has the read:user:bitbucket scope)" : "";
  const reviewerId = await resolveProviderUserId(app.db, app.encryptionKey, review, fetchPlatformIdentity, {
    refresh: true,
    onError: logIdentityError(app, review.id, "identità dell'account revisore: il provider ha risposto con un errore"),
  });
  if (reviewerId === null) {
    return {
      ok: false,
      status: 422,
      code: "review_account_identity_unresolved",
      message: `Could not read the review account's identity from the provider${scopeHint}`,
    };
  }
  // Il principale dalla cache se c'è: è l'identità con cui il webhook
  // lavorerà comunque, e un rinfresco fallito non deve bloccare la scelta del
  // revisore se quella salvata è buona.
  const mainId = await resolveProviderUserId(app.db, app.encryptionKey, mainAccount, fetchPlatformIdentity, {
    onError: logIdentityError(
      app,
      mainAccount.id,
      "identità dell'account principale: il provider ha risposto con un errore",
    ),
  });
  if (mainId === null) {
    return {
      ok: false,
      status: 422,
      code: "main_account_identity_unresolved",
      message: `Could not read the main account's identity from the provider${scopeHint}`,
    };
  }
  if (mainId === reviewerId) {
    return {
      ok: false,
      status: 400,
      code: "review_account_same_identity",
      message: "The two accounts belong to the same user on the provider",
    };
  }
  return { ok: true };
}
