import {
  comments,
  gitAccounts,
  prCorrections,
  repositories,
  ticketRepositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { parsePrNumberFromUrl, type ChangesRequestedEvent } from "@stubwise/git";
import {
  enqueueCorrection,
  isAuthorPermitted,
  resolveProviderUserId,
  WEBHOOK_REVIEW_BODY_ID,
} from "@stubwise/notifications";
import { stubwiseTicketNumber, type GitProviderKind, type PrComment } from "@stubwise/shared";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { t, type Language } from "@stubwise/i18n";
import type { FastifyBaseLogger } from "fastify";
import { getContentLanguage } from "../settings.js";
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
      // bottone "Applica le correzioni" sul ticket (design §5) — e il ticket lo
      // dice, col commento qui sotto. La causa l'ha
      // già scritta onError qui sopra; su Bitbucket la più frequente è un token
      // senza lo scope `read:user:bitbucket`, ma è un suggerimento, non la
      // diagnosi.
      log.warn(
        { repositoryId, prNumber, gitAccountId: accountId },
        "Request changes ignorato: identità dell'account di Stubwise non risolvibile (fail-closed)",
      );
      // L'unico scarto che una persona non può capire da sola: lo si dice sul
      // ticket (best-effort, deduplicato). Gli altri scarti restano muti.
      await postDroppedRequestNotice(ctx, {
        reason: "identity_unresolved",
        ticketId: row.ticketId,
        prNumber,
        login: event.actorLogin,
        accountName: account?.name ?? accountId,
      });
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
    // Chi ha premuto il bottone, o chi guarda la PR, deve poter capire perché
    // non è partito niente (best-effort, deduplicato PER MOTIVO: un estraneo
    // che insiste non riempie il ticket). `unverifiable` ha il SUO motivo:
    // dire «non ha il permesso» sarebbe falso.
    await postDroppedRequestNotice(ctx, {
      reason: verdict === "denied" ? "untrusted_author" : "permission_unverifiable",
      ticketId: row.ticketId,
      prNumber,
      login: event.actorLogin,
    });
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

const PLATFORM_NAME: Record<GitProviderKind, string> = { github: "GitHub", bitbucket: "Bitbucket" };

/** Perché un "Request changes" è stato scartato CON avviso sul ticket. */
export type DroppedRequestReason = "identity_unresolved" | "untrusted_author" | "permission_unverifiable";

/**
 * Il titolo (prima riga, chiave del dedup) di ciascun motivo: UNO per motivo.
 * Se due motivi condividessero il titolo, l'avviso dell'uno zittirebbe quello
 * dell'altro sulla stessa PR — guasti diversi, da far vedere entrambi.
 */
const NOTICE_TITLE_KEY = {
  identity_unresolved: "comment.changesRequestDropped.title",
  untrusted_author: "comment.changesRequestUntrusted.title",
  permission_unverifiable: "comment.changesRequestPermissionUnverifiable.title",
} as const satisfies Record<DroppedRequestReason, string>;

export type DroppedRequestNoticeInput =
  | { reason: "identity_unresolved"; prNumber: number; login: string; provider: GitProviderKind; accountName: string }
  | { reason: "untrusted_author"; prNumber: number; login: string; provider: GitProviderKind }
  | { reason: "permission_unverifiable"; prNumber: number; login: string; provider: GitProviderKind };

/**
 * Il commento di sistema di un "Request changes" scartato (design §5,
 * fail-closed; E3, permesso). Una riga per chiave del catalogo: il TITOLO è la
 * prima e porta il solo numero della PR — login, piattaforma e account stanno
 * nelle righe dopo, così il titolo resta uguale da un avviso all'altro e fa da
 * chiave del dedup. Testo SOLO da template i18n, mai da un modello.
 */
export function droppedRequestNoticeBody(lang: Language, input: DroppedRequestNoticeInput): string {
  const platform = PLATFORM_NAME[input.provider];
  const title = t(lang, NOTICE_TITLE_KEY[input.reason], { prNumber: input.prNumber });
  if (input.reason === "untrusted_author") {
    return [
      title,
      "",
      t(lang, "comment.changesRequestUntrusted.requestedBy", { login: input.login, platform }),
      t(lang, "comment.changesRequestUntrusted.reason", { platform }),
      t(lang, "comment.changesRequestUntrusted.meanwhile"),
    ].join("\n");
  }
  if (input.reason === "permission_unverifiable") {
    // «Non ha il permesso» sarebbe falso: il guasto è di configurazione (di
    // solito il token principale non legge i collaboratori), da far vedere a
    // un admin.
    return [
      title,
      "",
      t(lang, "comment.changesRequestPermissionUnverifiable.requestedBy", { login: input.login, platform }),
      t(lang, "comment.changesRequestPermissionUnverifiable.reason", { platform }),
      t(lang, "comment.changesRequestPermissionUnverifiable.meanwhile"),
    ].join("\n");
  }
  return [
    title,
    "",
    t(lang, "comment.changesRequestDropped.requestedBy", { login: input.login, platform }),
    t(lang, "comment.changesRequestDropped.reason", { account: input.accountName, platform }),
    ...(input.provider === "bitbucket" ? [t(lang, "comment.changesRequestDropped.bitbucketScope")] : []),
    t(lang, "comment.changesRequestDropped.meanwhile"),
  ].join("\n");
}

/**
 * È l'avviso di un "Request changes" scartato su QUESTA PR, per QUESTO motivo?
 * Unico punto in cui si riconosce: la PRIMA riga del commento deve essere
 * esattamente il titolo del template del motivo, renderizzato per `prNumber`
 * nella lingua `lang`. `reason` è OBBLIGATORIO, senza default: un chiamante
 * che non lo dice non deve ricadere per sbaglio sul dedup dell'altro motivo.
 *
 * Due cose da sapere prima di toccarla:
 *  1. se cambia la lingua dell'istanza o il testo del template, un avviso già
 *     scritto non si riconosce più e si riavvisa UNA volta. È un errore per
 *     eccesso, innocuo: un commento in più, mai una richiesta persa in silenzio;
 *  2. il titolo NON deve contenere dati variabili oltre al numero della PR —
 *     niente login né date: ogni avviso sarebbe diverso dal precedente e il
 *     dedup non tacerebbe mai. Per questo il login sta in una riga successiva.
 *     La stessa nota è accanto alle chiavi nel catalogo i18n, e un test in
 *     `packages/i18n` controlla i segnaposto dei titoli.
 */
export function isDroppedRequestNotice(
  body: string,
  prNumber: number,
  lang: Language,
  reason: DroppedRequestReason,
): boolean {
  const firstLine = body.split("\n", 1)[0];
  return firstLine === t(lang, NOTICE_TITLE_KEY[reason], { prNumber });
}

/** `Omit` distributivo: su un'unione tiene i campi propri di ogni ramo. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Scrive l'avviso sul ticket, a meno che ce ne sia già uno per questa PR non
 * "superato" da una richiesta dalla piattaforma riuscita DOPO di lui (prova che
 * l'identità era tornata risolvibile: allora questo è un guasto nuovo).
 * Limite accettato: credenziali sistemate e rotte di nuovo senza nessuna
 * richiesta riuscita in mezzo → silenzio.
 *
 * BEST-EFFORT: un errore si logga e basta — il webhook risponde 204 comunque,
 * e questo non avvia job né scrive in `pr_corrections`. La transazione con
 * l'advisory lock (chiave propria, non quella di `startRun`) serializza due
 * consegne DIVERSE arrivate insieme, che altrimenti scriverebbero due avvisi.
 */
async function postDroppedRequestNotice(
  ctx: ChangesRequestedContext,
  // il provider lo ha già `ctx`
  input: DistributiveOmit<DroppedRequestNoticeInput, "provider"> & { ticketId: string },
): Promise<void> {
  try {
    const lang = await getContentLanguage(ctx.db);
    const title = t(lang, NOTICE_TITLE_KEY[input.reason], { prNumber: input.prNumber });
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pr-dropped-notice:${input.ticketId}`}))`);
      // `starts_with` restringe in SQL; la decisione la prende isDroppedRequestNotice.
      const candidates = await tx
        .select({ body: comments.body, createdAt: comments.createdAt })
        .from(comments)
        .where(
          and(
            eq(comments.ticketId, input.ticketId),
            eq(comments.authorType, "system"),
            sql`starts_with(${comments.body}, ${title})`,
          ),
        )
        .orderBy(desc(comments.createdAt));
      const lastNotice = candidates.find((c) =>
        isDroppedRequestNotice(c.body, input.prNumber, lang, input.reason),
      );
      if (lastNotice) {
        const [succeededSince] = await tx
          .select({ id: prCorrections.id })
          .from(prCorrections)
          .where(
            and(
              eq(prCorrections.repositoryId, ctx.repositoryId),
              eq(prCorrections.prNumber, input.prNumber),
              eq(prCorrections.trigger, "provider"),
              gt(prCorrections.createdAt, lastNotice.createdAt),
            ),
          )
          .limit(1);
        if (!succeededSince) return; // già avvisato, e nulla è cambiato da allora
      }
      await tx.insert(comments).values({
        ticketId: input.ticketId,
        authorType: "system",
        authorId: null,
        // Solo template i18n: il testo non viene MAI da un modello.
        body: droppedRequestNoticeBody(lang, { ...input, provider: ctx.provider }),
      });
    });
  } catch (err) {
    ctx.log.warn(
      {
        repositoryId: ctx.repositoryId,
        prNumber: input.prNumber,
        reason: input.reason,
        err: err instanceof Error ? err.message : String(err),
      },
      "Request changes scartato: l'avviso sul ticket non è stato scritto",
    );
  }
}

