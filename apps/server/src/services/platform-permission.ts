import { getProvider } from "@stubwise/git";
import { decryptGitCredentials, type FetchAuthorPermission } from "@stubwise/notifications";
import type { GitProviderKind } from "@stubwise/shared";
import type { FastifyBaseLogger } from "fastify";

/**
 * Il {@link FetchAuthorPermission} del webhook: il permesso reale di un login
 * sulla repository, chiesto col token dell'account PRINCIPALE. Pigro apposta:
 * le credenziali si decifrano solo quando serve davvero chiedere (mai sulla
 * scorciatoia, mai su Bitbucket). Ogni errore LANCIA — `isAuthorPermitted` lo
 * trasforma in `unverifiable` — dopo averne scritto il messaggio nel log (i
 * GitProviderError non contengono il token).
 */
export function authorPermissionFetcher(
  // Solo `warn` del logger: è tutto ciò che usa, e un doppio nei test non deve
  // fingere un logger intero.
  ctx: { provider: GitProviderKind; encryptionKey: Buffer; log: Pick<FastifyBaseLogger, "warn"> },
  input: { repoUrl: string; defaultBranch: string; account: { id: string; encryptedCredentials: string } },
): FetchAuthorPermission {
  return async (login) => {
    try {
      const provider = getProvider(ctx.provider);
      if (!provider.getCollaboratorPermission) {
        throw new Error(`${ctx.provider}: il provider non sa dire il permesso di un utente`);
      }
      const credentials = decryptGitCredentials(input.account.encryptedCredentials, ctx.encryptionKey);
      if (!credentials) throw new Error("credenziali dell'account principale non decifrabili");
      return await provider.getCollaboratorPermission(
        { repoUrl: input.repoUrl, defaultBranch: input.defaultBranch, credentials },
        login,
      );
    } catch (err) {
      ctx.log.warn(
        { gitAccountId: input.account.id, login, err: err instanceof Error ? err.message : String(err) },
        "permesso dell'autore sul repository non verificabile",
      );
      throw err;
    }
  };
}
