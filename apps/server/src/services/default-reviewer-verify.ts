import { gitAccounts } from "@stubwise/db";
import { BITBUCKET_REVIEWER_SCOPES, getProvider } from "@stubwise/git";
import { decryptGitCredentials, type FetchPlatformIdentity } from "@stubwise/notifications";
import { abortableFetch, fetchPlatformIdentity, fetchPlatformIdentityWith } from "./platform-identity.js";

/**
 * Il revisore predefinito, la VERIFICA (lotto 6, voce 1): solo letture, sul
 * provider. Nessuna scrittura né in DB né sulla piattaforma — l'identità letta
 * si restituisce, la salva la scrittura (`default-reviewer-write.ts`) con la
 * sua guardia. La usano la rotta (`PUT …/default-reviewer`) e il preflight
 * del catalogo di Claude (che ci aggiunge il tempo massimo). Fail-closed: un
 * errore o un'eccezione sono un rifiuto col suo codice.
 */

type GitAccountRow = typeof gitAccounts.$inferSelect;

export type DefaultReviewerCheck =
  | { ok: true; providerUserId: string }
  | { ok: false; status: 400 | 422; code: string; message: string };

export async function verifyDefaultReviewer(
  row: GitAccountRow,
  key: Buffer,
  deps: { fetchIdentity?: FetchPlatformIdentity; onIdentityError?: (err: unknown) => void; signal?: AbortSignal } = {},
): Promise<DefaultReviewerCheck> {
  if (row.provider === "bitbucket" && !row.workspace) {
    return { ok: false, status: 422, code: "default_reviewer_workspace_missing", message: "A Bitbucket default reviewer needs a workspace: set it on the git account first" };
  }
  const credentials = decryptGitCredentials(row.encryptedCredentials, key);
  if (!credentials) return { ok: false, status: 400, code: "credentials_undecryptable", message: "Account credentials cannot be decrypted" };
  try {
    const checks = await getProvider(row.provider).validateAccount(
      { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
      { fetchImpl: deps.signal ? abortableFetch(deps.signal) : fetch, requiredScopes: BITBUCKET_REVIEWER_SCOPES },
    );
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) return { ok: false, status: 422, code: "default_reviewer_invalid", message: failed.map((c) => `${c.name}: ${c.detail}`).join("; ") };
  } catch {
    return { ok: false, status: 422, code: "default_reviewer_invalid", message: "The platform check failed" };
  }
  // L'identità, RINFRESCATA e non salvata: è il momento in cui l'admin deve sapere se il webhook riconoscerà le review.
  const scopeHint = row.provider === "bitbucket" ? " (on Bitbucket, check that the token has the read:user:bitbucket scope)" : "";
  let providerUserId: string | null = null;
  try {
    providerUserId = (await (deps.fetchIdentity ?? (deps.signal ? fetchPlatformIdentityWith(deps.signal) : fetchPlatformIdentity))({ provider: row.provider, credentials })) || null;
  } catch (err) {
    try {
      deps.onIdentityError?.(err);
    } catch {
      // Il log non cambia l'esito.
    }
  }
  if (!providerUserId) return { ok: false, status: 422, code: "review_account_identity_unresolved", message: `Could not read the account's identity from the provider${scopeHint}` };
  return { ok: true, providerUserId };
}
