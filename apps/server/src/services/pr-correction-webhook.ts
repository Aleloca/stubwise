import { gitAccounts, repositories, ticketRepositories, tickets, users, type Db } from "@stubwise/db";
import { parsePrNumberFromUrl, type ChangesRequestedEvent } from "@stubwise/git";
import {
  enqueueCorrection,
  isAuthorPermitted,
  resolveProviderUserId,
  WEBHOOK_REVIEW_BODY_ID,
} from "@stubwise/notifications";
import { stubwiseTicketNumber, type GitProviderKind, type PrComment } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { fetchPlatformIdentity } from "./platform-identity.js";
import { authorPermissionFetcher } from "./platform-permission.js";

/** Cosa è successo, per il log: la risposta HTTP è 204 in ogni caso. */
export type ChangesRequestedOutcome =
  | "enqueued"
  | "rejected"
  | "not_stubwise_pr"
  | "pr_not_open"
  | "identity_unresolved"
  | "own_account"
  // E3: l'autore non ha il permesso di chiedere modifiche sul repository
  | "untrusted_author"
  // E3, permesso reale: GitHub non ha saputo dire che permesso ha (fail-closed)
  | "permission_unverifiable";

export interface ChangesRequestedContext {
  db: Db;
  encryptionKey: Buffer;
  log: FastifyBaseLogger;
  repositoryId: string;
  provider: GitProviderKind;
}

/**
 * Gli id di consegna già visti (`X-GitHub-Delivery`, `X-Request-UUID`):
 * il provider ritrasmette un evento senza risposta in tempo con lo STESSO id, e
 * una seconda elaborazione diventerebbe una seconda correzione identica
 * (`pending`). In memoria, con scadenza: il server è un'istanza sola, e oltre
 * la finestra di ritrasmissione un id non torna più.
 *
 * `claim` è vero la prima volta; `release` lo libera quando l'elaborazione è
 * fallita, così il ritentativo di un 500 passa.
 */
export interface DeliveryDedupe {
  claim(deliveryId: string): boolean;
  release(deliveryId: string): void;
}

export function createDeliveryDedupe(ttlMs: number, now: () => number = Date.now): DeliveryDedupe {
  const seen = new Map<string, number>();
  return {
    claim(deliveryId) {
      const t = now();
      for (const [id, expiresAt] of seen) if (expiresAt <= t) seen.delete(id);
      if (seen.has(deliveryId)) return false;
      seen.set(deliveryId, t + ttlMs);
      return true;
    },
    release(deliveryId) {
      seen.delete(deliveryId);
    },
  };
}

/**
 * "Request changes" su una PR di Stubwise (design §9): diventa una correzione
 * `trigger = 'provider'`. Il cancello è il permesso della piattaforma — chi può
 * premere il bottone lassù fa ripartire il ciclo, qualunque ruolo abbia qui.
 *
 * Ordine, e perché:
 *  1. la PR dev'essere di Stubwise (`STUBWISE_BRANCH_RE` di @stubwise/shared),
 *     aperta, e QUELLA della riga `ticket_repositories` (un numero diverso
 *     sullo stesso branch è una PR vecchia o di qualcun altro);
 *  2. il filtro degli account propri, FAIL-CLOSED (design §5), PRIMA di
 *     qualunque scrittura;
 *  2b. il PERMESSO dell'autore sul repository (emendamento E3,
 *     `isAuthorPermitted`): su GitHub owner, membri e collaboratori passano
 *     per `author_association` (scorciatoia), tutti gli altri solo col
 *     permesso reale write/maintain/admin, chiesto col token principale —
 *     su un repository pubblico chiunque preme il bottone. Tre esiti:
 *     `permitted` procede, `denied` e `unverifiable` scartano con un avviso
 *     sul ticket, ciascuno col suo motivo (step 12–19). DOPO il punto 2,
 *     apposta: un evento del nostro revisore resta «proprio», e muto,
 *     qualunque associazione abbia;
 *  3. chi l'ha chiesto, il testo della review, l'accodamento. I commenti della
 *     PR NON si leggono qui: la fotografia la rifà il worker all'avvio (C8), e
 *     il webhook deve rispondere in fretta (ritrasmissione dopo ~10 s).
 */
export async function handleChangesRequested(
  ctx: ChangesRequestedContext,
  event: ChangesRequestedEvent,
): Promise<ChangesRequestedOutcome> {
  const { db, log, repositoryId } = ctx;
  const ticketNumber = stubwiseTicketNumber(event.sourceBranch);
  if (ticketNumber === null) return "not_stubwise_pr";

  const [row] = await db
    .select({
      ticketId: tickets.id,
      prUrl: ticketRepositories.prUrl,
      prState: ticketRepositories.prState,
      prNumber: ticketRepositories.prNumber,
      gitAccountId: repositories.gitAccountId,
      reviewGitAccountId: repositories.reviewGitAccountId,
      // step 2b: la chiamata del permesso reale
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .innerJoin(
      tickets,
      and(eq(tickets.projectId, repositories.projectId), eq(tickets.number, ticketNumber)),
    )
    .innerJoin(
      ticketRepositories,
      and(
        eq(ticketRepositories.ticketId, tickets.id),
        eq(ticketRepositories.repositoryId, repositories.id),
      ),
    )
    .where(eq(repositories.id, repositoryId));
  if (!row || row.prState !== "open" || row.prUrl === null) return "pr_not_open";
  const prNumber = row.prNumber ?? parsePrNumberFromUrl(row.prUrl);
  if (prNumber !== event.prNumber) return "pr_not_open";

  // --- 2. Gli account di Stubwise su questa repository, fail-closed. ---
  const accountIds = [row.gitAccountId, ...(row.reviewGitAccountId ? [row.reviewGitAccountId] : [])];
  const accounts = await db.select().from(gitAccounts).where(inArray(gitAccounts.id, accountIds));
  const ownIds: string[] = [];
  for (const accountId of accountIds) {
    const account = accounts.find((a) => a.id === accountId);
    const resolved = account
      ? await resolveProviderUserId(db, ctx.encryptionKey, account, fetchPlatformIdentity, {
          // Il motivo VERO (401, 403 con lo scope mancante, rate limit…): il
          // messaggio di GitProviderError non contiene il token.
          onError: (err) =>
            log.warn(
              { repositoryId, gitAccountId: accountId, err: err instanceof Error ? err.message : String(err) },
              "identità dell'account di Stubwise: il provider ha risposto con un errore",
            ),
        })
      : null;
    if (resolved === null) {
      // Un ciclo infinito costa più di una richiesta persa, che si ripete dal
      // bottone "Applica le correzioni" sul ticket (design §5). La causa l'ha
      // già scritta onError qui sopra; su Bitbucket la più frequente è un token
      // senza lo scope `read:user:bitbucket`, ma è un suggerimento, non la
      // diagnosi.
      log.warn(
        { repositoryId, prNumber, gitAccountId: accountId },
        "Request changes ignorato: identità dell'account di Stubwise non risolvibile (fail-closed)",
      );
      return "identity_unresolved";
    }
    ownIds.push(resolved);
  }
  if (ownIds.includes(event.actorId)) {
    log.info({ repositoryId, prNumber }, "Request changes scritto da un account di Stubwise: scartato");
    return "own_account";
  }

  // --- 2b. Chi ha il permesso di chiedere modifiche (E3, permesso reale). ---
  // La stessa regola che filtra la fotografia dei commenti (C8): un estraneo
  // non fa partire una correzione, e il suo testo non entra nel prompt.
  // `author_association` fidata = scorciatoia, nessuna chiamata; altrimenti il
  // permesso reale, col token dell'account PRINCIPALE (step 16).
  const mainAccount = accounts.find((a) => a.id === row.gitAccountId)!;
  const verdict = await isAuthorPermitted(
    { login: event.actorLogin, association: event.authorAssociation },
    ctx.provider,
    authorPermissionFetcher(ctx, { repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, account: mainAccount }),
  );
  if (verdict !== "permitted") {
    log.info(
      { repositoryId, prNumber, actorLogin: event.actorLogin, authorAssociation: event.authorAssociation, verdict },
      verdict === "denied"
        ? "Request changes da un account senza permesso sul repository: scartato"
        : "Request changes: permesso dell'autore non verificabile, scartato (fail-closed)",
    );
    // avviso sul ticket: step 14 (denied) e step 18 (unverifiable)
    return verdict === "denied" ? "untrusted_author" : "permission_unverifiable";
  }

  // --- 3. Chi, cosa, e l'accodamento. ---
  const requestedByUserId =
    ctx.provider === "bitbucket" ? await findBitbucketUser(db, event.actorLogin) : null;

  const result = await enqueueCorrection(db, {
    ticketId: row.ticketId,
    repositoryId,
    prNumber,
    trigger: "provider",
    ...(requestedByUserId ? { requestedByUserId } : {}),
    // Sempre, anche quando la persona è collegata: è il nome con cui la riga
    // di stato la mostra ("richieste da mario.rossi su Bitbucket").
    requestedByProviderLogin: event.actorLogin,
    // Niente `reviewId`: enqueueCorrection usa già l'ultima review completed
    // della PR (A6). Fotografia MAI null: la rifà il worker all'avvio.
    providerFeedback: reviewBodyFeedback(event),
  });
  if (!result.ok) {
    // Con `trigger: "provider"` non dovrebbe mai succedere (un job vivo
    // diventa `pending`): se succede, lo si dice nel log invece di perderlo.
    log.warn({ repositoryId, prNumber, error: result.error }, "Request changes non accodato");
    return "rejected";
  }
  log.info(
    { repositoryId, prNumber, correctionId: result.correctionId, status: result.status },
    "Request changes dalla piattaforma: correzione accodata",
  );
  return "enqueued";
}

/**
 * Il membro Stubwise collegato a uno username Bitbucket (`users.bitbucketUsername`,
 * gestito da `routes/git-identity-routes.ts`). Case-insensitive: lo username
 * lo scrive a mano un admin. GitHub non ha un collegamento: resta il solo login.
 *
 * Attenzione a cosa arriva come `login`: su Bitbucket `actorLogin` è il
 * `nickname` dell'account, se manca il `display_name`, e come ultima risorsa
 * l'uuid (`bitbucketAccount` in `packages/git/src/bitbucket.ts`). Può quindi
 * NON coincidere con `users.bitbucketUsername`, scritto a mano: in quel caso
 * manca il collegamento alla persona (`requestedByUserId` resta assente) e la
 * riga di stato mostra il solo login. Innocuo: la correzione parte lo stesso,
 * perde solo il nome del membro.
 */
async function findBitbucketUser(db: Db, login: string): Promise<string | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.bitbucketUsername}) = lower(${login})`)
    .limit(1);
  return user?.id ?? null;
}

/** La fotografia minima del webhook: il solo testo della review, se c'è. */
function reviewBodyFeedback(event: ChangesRequestedEvent): PrComment[] {
  const body = event.reviewBody?.trim();
  if (!body) return [];
  return [
    {
      // `WEBHOOK_REVIEW_BODY_ID` di `@stubwise/notifications` — mai una costante
      // locale né il letterale: C8 deve riconoscere la stessa voce. È il
      // RIPIEGO: il worker rifà la fotografia (C8) e la SOSTITUISCE (su GitHub
      // la stessa review torna come `review-<id>`, B5); resta se la lettura
      // fallisce o se la rilettura non porta più quella review (C8 la conserva).
      id: WEBHOOK_REVIEW_BODY_ID,
      authorId: event.actorId,
      authorLogin: event.actorLogin,
      body,
      createdAt: new Date().toISOString(),
      path: null,
      line: null,
      // Già verificata (step 2b): la porta con sé, così la fotografia minima
      // passa lo stesso filtro di quella che rifà il worker.
      authorAssociation: event.authorAssociation,
    },
  ];
}
