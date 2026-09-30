import { createHmac, timingSafeEqual } from "node:crypto";
import { prNumberFromUrl, type GitProviderKind, type PrComment } from "@stubwise/shared";

/**
 * Git configuration of a project, with credentials ALREADY decrypted.
 * Decryption is the caller's responsibility (worker/server); this package
 * never touches crypto-at-rest.
 */
export interface ProjectGitConfig {
  /** e.g. https://bitbucket.org/workspace/repo or https://github.com/owner/repo */
  repoUrl: string;
  defaultBranch: string;
  credentials: {
    /**
     * Git identity for Basic auth over HTTPS (clone/fetch/push). For Bitbucket
     * this is the Bitbucket username (required by API tokens AND legacy app
     * passwords); unused by GitHub (which uses x-access-token).
     */
    username?: string;
    /**
     * REST API identity (Atlassian email) — only needed for Bitbucket API
     * tokens, which require the email (not the username) on api.bitbucket.org.
     * Absent for legacy app passwords, where the REST call falls back to
     * `username`. Unused by GitHub.
     */
    email?: string;
    token: string;
  };
}

/**
 * Credenziali git già decifrate, senza repo: usate dai metodi che operano a
 * livello di account (elenco repository/branch) anziché di singolo progetto.
 * Stessa forma di {@link ProjectGitConfig.credentials} più il provider, così
 * un account può essere passato direttamente senza un progetto memorizzato.
 */
export interface AccountCredentials {
  provider: GitProviderKind;
  credentials: {
    username?: string;
    email?: string;
    token: string;
  };
}

/**
 * Configurazione a livello di account passata a validateAccount/listRepositories:
 * le {@link AccountCredentials} più, opzionalmente, lo slug del `workspace`. Su
 * Bitbucket il workspace è obbligatorio (gli endpoint globali/account sono stati
 * dismessi — CHANGE-2770 — e restituiscono 410: si può elencare solo per
 * workspace via GET /2.0/repositories/{workspace}). GitHub lo ignora (resta
 * null) e continua a usare /user/repos.
 */
export interface AccountConfig {
  credentials: AccountCredentials;
  workspace?: string;
}

/**
 * Riepilogo di un repository remoto restituito da listRepositories.
 * `fullName` è "owner/repo" (workspace/repo su Bitbucket), `cloneUrl` è l'URL
 * https di clone, `defaultBranch` può mancare (null) se il provider non lo
 * espone nell'elenco.
 */
export interface RepoSummary {
  fullName: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
}

export interface WebhookEvent {
  kind: "merged" | "closed_unmerged";
  provider: GitProviderKind;
  /** Source branch della PR. */
  branch: string;
  prUrl: string;
  /**
   * Numero della PR sul provider (GitHub number / Bitbucket id); null se il
   * provider non lo fornisce nel payload. La chiusura del ticket non ne
   * dipende (usa il branch): serve solo al cleanup della review, che in sua
   * assenza viene semplicemente saltato.
   */
  prNumber: number | null;
}

/**
 * Evento di apertura/aggiornamento di una PR (automazione PR Review).
 * `opened` copre anche la riapertura; `updated` è un push sulla source branch
 * (GitHub `synchronize`) o una modifica della PR (Bitbucket `pullrequest:updated`,
 * che scatta anche su edit di titolo/descrizione: il debounce assorbe il rumore).
 */
export interface PrActivityEvent {
  kind: "opened" | "updated";
  provider: GitProviderKind;
  prNumber: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  prUrl: string;
}

/**
 * Evento di PUSH su un branch estratto da un webhook git. A differenza di
 * {@link WebhookEvent} (PR chiuse), descrive un push diretto su un branch:
 * serve all'auto-aggiornamento Docs quando il branch di default avanza.
 */
export interface PushWebhookEvent {
  /** Nome del branch (es. "main"), senza il prefisso "refs/heads/". */
  branch: string;
  /** Commit precedente; "0".repeat(40) se il branch è appena stato creato. */
  beforeSha: string;
  /** Nuovo HEAD del branch dopo il push. */
  afterSha: string;
  /** Commit inclusi nel push, dal più vecchio al più recente come li espone il provider. */
  commits: { sha: string; message: string }[];
}

/**
 * Il commento di una PR ha UNA sola definizione: lo schema `prCommentSchema`
 * di `@stubwise/shared` (tappa A, Task A3), che tipizza anche la colonna
 * `pr_corrections.provider_feedback`. Qui lo si importa (in cima al file) e lo
 * si riesporta, così l'`export *` di `index.ts` continua a offrirlo ai
 * consumatori di `@stubwise/git` senza una seconda fonte di verità
 * (`packages/git` dipende già da `@stubwise/shared`). Il docblock sulla
 * semantica (`authorId`, `line` nuova/vecchia) sta sullo schema.
 */
export type { PrComment };

/** Stato di uno status di commit di Stubwise: in corso, approvata, modifiche richieste. */
export type CommitStatusState = "pending" | "success" | "failure";

/**
 * Chiave dello status di commit di Stubwise (design §8). Una sola, esportata:
 * chi scrive lo status (worker) e chi lo filtra (server) importano questa
 * costante invece di ripetere il letterale, così le due metà non divergono.
 */
export const STUBWISE_REVIEW_STATUS_KEY = "stubwise-review" as const;

/**
 * Status di commit scritto da Stubwise (design §8). `key` è fisso: è la
 * chiave che le regole del branch possono rendere obbligatoria, e uno status
 * con la stessa chiave SOVRASCRIVE il precedente sullo stesso commit (così
 * "in corso" diventa "approvata" invece di affiancarlesi).
 */
export interface CommitStatusInput {
  state: CommitStatusState;
  key: typeof STUBWISE_REVIEW_STATUS_KEY;
  description: string;
  url?: string;
  /**
   * Branch sorgente della PR. Solo Bitbucket lo usa (`refname`): la sua
   * documentazione dice che serve ad associare lo status alla PR. GitHub lo
   * ignora (associa per sha).
   */
  refname?: string;
}

/** Verdetto pubblicato come stato vero della PR dall'account revisore. */
export type PrReviewVerdict = "approve" | "request_changes";

/**
 * "Request changes" arrivato dal webhook (Bitbucket
 * `pullrequest:changes_request_created`, GitHub `pull_request_review` con
 * `review.state = changes_requested`). `actorId` è la stessa identità di
 * {@link PrComment.authorId}: il chiamante la confronta con gli account di
 * Stubwise PRIMA di qualunque scrittura (design §5). `reviewBody` è il testo
 * della review su GitHub; Bitbucket non ne manda uno (sempre `null`).
 */
export interface ChangesRequestedEvent {
  prNumber: number;
  sourceBranch: string;
  actorId: string;
  actorLogin: string;
  reviewBody: string | null;
  /**
   * Il rapporto dell'autore col repository: `review.author_association` di
   * GitHub (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`…),
   * maiuscolo come GitHub lo manda; `null` se assente. Bitbucket non ha un
   * equivalente: sempre `null`. Il chiamante lo passa a
   * `isTrustedAuthorAssociation` (`@stubwise/notifications`) prima di far
   * partire una correzione: su un repository pubblico chiunque può chiedere
   * modifiche.
   */
  authorAssociation: string | null;
}

/**
 * Esito di una singola sonda di validazione delle credenziali. `name` è
 * l'etichetta umana del controllo (es. "Accesso git (push)"), `ok` dice se è
 * passato, `detail` è un messaggio in italiano comprensibile all'utente.
 */
export interface CredentialCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Esito della registrazione idempotente di un webhook sul provider git.
 * `created`/`updated` sono mutuamente esclusivi: il primo se il webhook non
 * esisteva ed è stato creato, il secondo se ne esisteva già uno con lo stesso
 * URL ed è stato aggiornato (attivo, eventi e secret rinfrescati). `id` è
 * l'identificativo del webhook lato provider (uuid Bitbucket / id numerico
 * GitHub), `detail` un messaggio in italiano per la UI.
 */
export interface WebhookResult {
  created: boolean;
  updated: boolean;
  id: string;
  detail: string;
}

/**
 * Esito di UN check del provider (GitHub Actions check run / Bitbucket build
 * status). `pending` copre sia "in corso" sia "in coda" — nessuna delle due
 * è ancora un verdetto.
 */
export type CheckOutcomeStatus = "success" | "failure" | "pending";

/** Un singolo check con nome ed esito, per il dettaglio nella coda di rilascio. */
export interface PullRequestCheck {
  name: string;
  status: CheckOutcomeStatus;
}

/**
 * Rollup dei check di una PR (fase 8, Task 5; `unknown` fase 8, review
 * fix Task 2). `no_checks` è un caso a SÉ, non "success": una PR senza CI
 * configurata non ha dimostrato nulla, e confonderla con una PR verde
 * nasconderebbe l'assenza di verifica. `unknown` è un caso ANCORA diverso
 * da `no_checks`: non è "non c'è CI configurata", è "non sono riuscito a
 * leggere se c'è" (rete, 401, corpo malformato) — confonderlo con
 * `no_checks` (che NON blocca il rilascio) aprirebbe il cancello proprio
 * quando la lettura fallisce nell'istante sbagliato, cioè quando una PR ha
 * i check rossi ma la risposta del provider non è arrivata. Il rollup dei
 * check singoli resta: qualunque `failure` → `failure`; nessun `failure` ma
 * qualche `pending` → `pending`; tutti `success` → `success`; nessun check
 * → `no_checks`; qualunque errore di lettura → `unknown` (mai `no_checks`).
 */
export interface PullRequestChecks {
  status: CheckOutcomeStatus | "no_checks" | "unknown";
  checks: PullRequestCheck[];
  /**
   * Head sha della PR AL MOMENTO di questa lettura (fase 8, review fix
   * Task 4) — risolto dalla STESSA chiamata che legge i check, mai da un
   * artefatto di un'altra automazione (`pr_reviews.headSha`, scritto solo
   * se la PR review è accesa e per QUESTA PR è già girata). Assente quando
   * la lettura è fallita prima di risolvere la PR (`status: "unknown"`
   * senza aver mai visto la risposta) — mai un valore stantio.
   */
  headSha?: string;
  /**
   * Nome del branch sorgente, dalla STESSA risposta di `headSha` (fase 8,
   * review fix Task 1): serve alla coda di rilascio per etichettare una PR
   * aperta fuori da Stubwise, che non ha un branch `stubwise/ticket-N` noto
   * da nessun'altra parte. Stessa regola di assenza di `headSha`.
   */
  headRef?: string;
}

/**
 * Rollup condiviso fra GitHub e Bitbucket (vedi {@link PullRequestChecks}):
 * un solo `failure` decide, poi un `pending` non ancora concluso, altrimenti
 * tutti `success`. Il caso "nessun check" è deciso dal CHIAMANTE (lista
 * vuota), non da questa funzione — che quindi non va mai invocata su un
 * array vuoto: chi la chiama controlla `checks.length === 0` prima.
 */
export function rollupCheckStatus(checks: PullRequestCheck[]): CheckOutcomeStatus {
  if (checks.some((c) => c.status === "failure")) return "failure";
  if (checks.some((c) => c.status === "pending")) return "pending";
  return "success";
}

/**
 * Provider abstraction over Bitbucket Cloud and GitHub.
 *
 * Webhook contract (Task 25 server route):
 * 1. call `verifyWebhook(headers, rawBody, secret)` FIRST, with the RAW
 *    request body (string/Buffer, before any JSON parsing) — the HMAC is
 *    computed over the raw payload bytes;
 * 2. only if it returns true, JSON-parse the body and call
 *    `parseWebhook(headers, body)`.
 * `parseWebhook` performs NO signature verification on purpose.
 *
 * The `headers` parameters expect headers already normalized to
 * `Record<string, string>`: Node/Fastify expose them as
 * `string | string[] | undefined`, so the caller (the Task 25 server route)
 * must normalize them at the boundary before calling this interface.
 */
export interface GitProvider {
  /** https URL with credentials embedded, suitable for `git clone`/`git push`. */
  getCloneUrl(p: ProjectGitConfig): string;
  /**
   * Value for the `Authorization` header to authenticate git-over-https
   * operations WITHOUT persisting credentials anywhere on disk: callers pass
   * it per-invocation via `git -c http.extraheader="Authorization: <value>"`
   * so the remote URL stored in the repo config stays credential-free.
   * Both providers use Basic auth: GitHub's smart-http endpoints accept a PAT
   * as `x-access-token:<token>` Basic credentials (Bearer is unreliable for
   * git endpoints), Bitbucket git-over-https is `username:token` Basic for both
   * API tokens and legacy app passwords (the REST API differs — it needs the
   * Atlassian email for API tokens; see openPullRequest in bitbucket.ts).
   */
  getAuthHeader(p: ProjectGitConfig): string;
  openPullRequest(
    p: ProjectGitConfig,
    pr: { branch: string; title: string; body: string }
  ): Promise<{ url: string }>;
  /** Stato attuale della PR: 'open' se ancora aperta, 'closed' se mergiata/chiusa. */
  getPullRequestState(
    p: ProjectGitConfig,
    prNumber: number,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<"open" | "closed">;
  /**
   * Stato dei check del provider (fase 8, Task 5) — GitHub Actions check-run
   * sull'ultimo commit della PR, Bitbucket build status. **È la colonna che
   * conta** per la coda di rilascio (design §4): il test interno è ciò che la
   * pipeline ha eseguito nel proprio container PRIMA di aprire la PR, questo è
   * ciò che decide se il provider considera la PR mergiabile. Sola lettura,
   * non lancia mai: un errore di rete/parsing torna `{ status: "unknown",
   * checks: [] }` — un caso DIVERSO da "nessuna CI configurata"
   * (`no_checks`), che il chiamante deve poter distinguere (fase 8, review
   * fix Task 2): confondere "non sono riuscito a leggere" con "non c'è
   * niente da leggere" aprirebbe il cancello di rilascio proprio quando la
   * lettura fallisce su una PR che in realtà ha i check rossi.
   */
  getPullRequestChecks(
    p: ProjectGitConfig,
    prNumber: number,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<PullRequestChecks>;
  /**
   * Mergia una PR sul provider (fase 8, Task 8) — l'UNICA scrittura verso
   * produzione che Stubwise fa mai, e SOLO su chiamata esplicita (mai
   * auto-merge, design §1/§4). Lancia sempre e solo
   * {@link MergeNotAllowedError} quando il merge non va a buon fine — mai il
   * caso felice silenzioso: il chiamante (la rotta di rilascio, requireAdmin)
   * distingue i rami d'errore per `reason`, non per uno status HTTP.
   */
  mergePullRequest(
    p: ProjectGitConfig,
    prNumber: number,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<{ merged: true; sha: string }>;
  /**
   * Pubblica un commento NUOVO sulla PR. Ogni review (una per push) lascia il
   * suo commento: la storia delle review resta leggibile nella conversazione
   * della PR, invece di essere riscritta sull'unico commento della prima.
   */
  createPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    body: string,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<void>;
  /**
   * Commenti della PR — generali e sulle righe (GitHub: anche il testo delle
   * review inviate) — per la fotografia del feedback umano (design §9). Mai
   * cancellati, bozze o vuoti; mai commenti senza un autore riconoscibile
   * (il chiamante esclude gli account di Stubwise per `authorId`). Lancia
   * GitProviderError: una fotografia parziale non si prende.
   */
  listPrComments(
    p: ProjectGitConfig,
    prNumber: number,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<PrComment[]>;
  /**
   * Scrive (o sovrascrive, stessa `key`) lo status di commit di Stubwise
   * sullo sha COMPLETO (design §8). Lancia GitProviderError, anche su uno
   * sha abbreviato prima di qualunque richiesta: il chiamante lo tratta come
   * best-effort, un errore non ferma il ciclo.
   */
  setCommitStatus(
    p: ProjectGitConfig,
    sha: string,
    status: CommitStatusInput,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<void>;
  /**
   * Pubblica il verdetto della review come stato vero della PR, testo
   * compreso (Bitbucket: commento + approve/request-changes; GitHub: una
   * review). Va chiamato con l'account REVISORE: GitHub rifiuta i due
   * verdetti all'autore della PR (422), Bitbucket li accetta ma
   * l'approvazione dell'autore non conta per i merge check. Sostituisce
   * `createPrComment` quando l'account revisore c'è. Lancia GitProviderError.
   */
  submitPrReview(
    p: ProjectGitConfig,
    prNumber: number,
    verdict: PrReviewVerdict,
    body: string,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<void>;
  /**
   * Identità stabile dell'account delle credenziali (uuid Bitbucket con le
   * graffe / id numerico GitHub come stringa), nella stessa forma di
   * `ChangesRequestedEvent.actorId` e `PrComment.authorId`. Accetta
   * qualunque oggetto con `credentials` (ProjectGitConfig o
   * AccountCredentials). Lancia GitProviderError.
   */
  getAuthenticatedUserId(
    p: Pick<ProjectGitConfig, "credentials">,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<string>;
  /**
   * Returns a WebhookEvent if the webhook payload represents a closed PR —
   * `kind: "merged"` if it was merged, `kind: "closed_unmerged"` if it was
   * closed/rejected without merging — otherwise null. Never throws on malformed
   * input. Does NOT verify the signature — call verifyWebhook first.
   */
  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent | null;
  /** Eventi PR opened/updated per l'automazione PR Review; null se non pertinente. */
  parsePrEvent(headers: Record<string, string>, body: unknown): PrActivityEvent | null;
  /**
   * Returns a PushWebhookEvent if the webhook payload represents a push to a
   * branch, otherwise null (PR events, tag pushes, branch deletes, malformed
   * bodies). Never throws on malformed input. Does NOT verify the signature —
   * call verifyWebhook first.
   */
  parsePushEvent(headers: Record<string, string>, body: unknown): PushWebhookEvent | null;
  /**
   * "Request changes" su una PR (Bitbucket
   * `pullrequest:changes_request_created`, GitHub `pull_request_review`
   * submitted con stato changes_requested), altrimenti null. Mutuamente
   * esclusivo con parseWebhook/parsePrEvent/parsePushEvent: nessun payload è
   * riconosciuto da due parser. Mai lancia. NON verifica la firma — chiamare
   * prima verifyWebhook.
   */
  parseChangesRequestedEvent(
    headers: Record<string, string>,
    body: unknown
  ): ChangesRequestedEvent | null;
  /**
   * Verifies the webhook HMAC-SHA256 signature against the RAW body.
   * Returns false if the signature header is missing or invalid.
   * Note: Bitbucket Cloud marks the webhook secret as optional in its UI,
   * but Stubwise requires it — unsigned webhooks are rejected.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string | Buffer, secret: string): boolean;
  /**
   * Verifica, usando solo richieste HTTPS (niente git CLI), che le credenziali
   * inserite autentichino e abbiano gli scope di cui ha bisogno la pipeline AI:
   * push git sul repo E accesso REST per aprire le pull request. Restituisce un
   * elenco di controlli con esito ed eventuale spiegazione. Non lancia mai:
   * ogni problema (rete inclusa) diventa un check con `ok: false`.
   */
  validateCredentials(
    p: ProjectGitConfig,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<CredentialCheck[]>;
  /**
   * Valida le credenziali a LIVELLO DI ACCOUNT (niente repo): verifica solo che
   * il TOKEN autentichi e abbia accesso in lettura ai repository. Serve alla
   * validazione di un account git non ancora collegato a un repo specifico (i
   * check repo-specifici — push git / PR / webhook — vivono in
   * validateCredentials e vengono eseguiti nel wizard dopo la scelta del repo).
   * Come validateCredentials non lancia mai: ogni problema (rete inclusa)
   * diventa un check con `ok: false`.
   */
  validateAccount(
    config: AccountConfig,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<CredentialCheck[]>;
  /**
   * Registra in modo idempotente il webhook del repository (PR
   * aperte/aggiornate/chiuse, "Request changes", push) sul provider git usando
   * l'autenticazione REST (Bitbucket: email-o-username:token Basic; GitHub:
   * Bearer). Elenca i webhook esistenti, cerca quello con lo stesso target URL
   * di `hook.url`: se lo trova lo aggiorna (attivo + eventi corretti + secret
   * rinfrescato), altrimenti lo crea. A differenza di validateCredentials può
   * lanciare, ma SOLO GitProviderError con un messaggio in italiano chiaro
   * (es. su 403/scope insufficiente: indica all'utente lo scope mancante).
   */
  ensureWebhook(
    p: ProjectGitConfig,
    hook: { url: string; secret: string },
    opts?: { fetchImpl?: FetchLike }
  ): Promise<WebhookResult>;
  /**
   * Elenca i repository accessibili con le credenziali dell'account (NON serve
   * un progetto memorizzato): serve alla UI per scegliere il repo quando si
   * crea un progetto. Pagina i risultati fino a un tetto documentato per
   * provider (~300 repo / ~3 pagine). Lancia SOLO GitProviderError con un
   * messaggio in italiano su 401/403.
   */
  listRepositories(config: AccountConfig, opts?: { fetchImpl?: FetchLike }): Promise<RepoSummary[]>;
  /**
   * Elenca i branch di un repository (per nome completo "owner/repo") usando le
   * credenziali dell'account, più il branch di default. Pagina fino a un tetto
   * documentato (~200 branch). Lancia SOLO GitProviderError su 401/403.
   */
  listBranches(
    p: AccountCredentials,
    repoFullName: string,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<{ branches: string[]; defaultBranch: string | null }>;
}

/**
 * Perché `mergePullRequest` si è rifiutato di mergiare (fase 8, Task 8). Non
 * il solo caso felice: `not_mergeable` copre conflitti E check obbligatori
 * non passati (i provider non li distinguono sempre nello status HTTP),
 * `forbidden` il permesso mancante, `unknown` qualunque altra risposta non
 * riconosciuta.
 *
 * ⚠️ **Non esiste un `"already_merged"` qui, ed è deliberato** (fase 8,
 * review fix Task 4): nessuno dei due provider lo lanciava mai — GitHub e
 * Bitbucket rispondono allo stesso modo (405/400/409, mappati su
 * `not_mergeable`) sia per conflitti reali sia per una PR già mergiata da
 * qualcun altro, e nessuno dei due corpi risposta distingue i due casi in
 * modo affidabile. Un ramo dichiarato e irraggiungibile è peggio di uno
 * assente. La distinzione, quando serve, la fa il CHIAMANTE con un dato
 * verificato — non inferito dallo status HTTP del fallimento —: su
 * `not_mergeable` la rotta di rilascio rilegge `getPullRequestState` e
 * riclassifica come "già chiusa" solo se il provider lo conferma
 * (`apps/server/src/services/release.ts`).
 */
export type MergeFailureReason = "not_mergeable" | "forbidden" | "unknown";

export class GitProviderError extends Error {
  readonly status: number;
  /** Response body, truncated to 500 characters. */
  readonly responseText: string;

  constructor(message: string, status: number, responseText: string) {
    super(message);
    this.name = "GitProviderError";
    this.status = status;
    this.responseText = responseText;
  }
}

/**
 * Lanciato SOLO da `mergePullRequest`, mai `GitProviderError` direttamente:
 * il chiamante (la rotta di rilascio) ha un solo tipo da distinguere per
 * `reason`, non uno status HTTP da reinterpretare.
 */
export class MergeNotAllowedError extends GitProviderError {
  readonly reason: MergeFailureReason;
  constructor(reason: MergeFailureReason, message: string, status: number, responseText: string) {
    super(message, status, responseText);
    this.name = "MergeNotAllowedError";
    this.reason = reason;
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GitProviderOptions {
  fetchImpl?: FetchLike;
}

export interface ParsedRepoUrl {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parses an https repo URL into host, owner (workspace) and repo slug.
 * Tolerates a trailing `.git` and/or trailing slash; credentials embedded
 * in the URL are dropped. Throws a clear error on anything that is not
 * `https://host/owner/repo` (ssh:// and http:// are rejected).
 */
export function parseRepoUrl(repoUrl: string): ParsedRepoUrl {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error(`Unparsable repo URL: "${repoUrl}" (expected https://host/owner/repo)`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `URL repo non supportato: "${repoUrl}" — sono accettati solo URL https://host/owner/repo (niente ssh:// o http://)`
    );
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) {
    throw new Error(`Unparsable repo URL: "${repoUrl}" (expected https://host/owner/repo)`);
  }
  const [owner, rawRepo] = segments as [string, string];
  const repo = rawRepo.replace(/\.git$/, "");
  if (owner.length === 0 || repo.length === 0) {
    throw new Error(`Unparsable repo URL: "${repoUrl}" (expected https://host/owner/repo)`);
  }
  return { host: url.host, owner, repo };
}

/**
 * Estrae il numero della PR dal suo URL (fase 8, Task 9): GitHub
 * `.../pull/N`, Bitbucket `.../pull-requests/N` (e `/pulls/N`). `null` se il
 * formato non è riconosciuto — MAI lancia: chi lo chiama (la coda di rilascio)
 * legge un URL salvato da un run precedente e non deve rompersi su un formato
 * imprevisto. Delega a `prNumberFromUrl` di @stubwise/shared, la regola unica
 * del monorepo; il nome resta perché lo usano altri (es. `release.ts`).
 */
export function parsePrNumberFromUrl(prUrl: string): number | null {
  return prNumberFromUrl(prUrl);
}

/**
 * Vero se `sha` è uno sha git COMPLETO (40 esadecimali). Gli status di commit
 * lo esigono su entrambi i provider; lo sha di `pr_review_jobs.head_sha` di
 * Bitbucket è abbreviato e va risolto nel mirror prima di arrivare qui.
 */
export function isFullCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/i.test(sha);
}

/** Reads a header value case-insensitively. */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Constant-time check of `signatureHeader` ("sha256=<hex>") against the
 * HMAC-SHA256 of `rawBody` keyed with `secret`. Used by both GitHub
 * (X-Hub-Signature-256) and Bitbucket Cloud (X-Hub-Signature) — same scheme.
 */
export function verifyHmacSignature(
  signatureHeader: string | undefined,
  rawBody: string | Buffer,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const hex = signatureHeader.slice("sha256=".length);
  // Buffer.from(x, "hex") never throws — it silently truncates at the first
  // invalid character — so validate the hex string explicitly instead.
  if (!/^[0-9a-f]+$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(hex, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Lancia GitProviderError sui non-2xx delle chiamate di elenco (repository/
 * branch), con messaggio in italiano dedicato a 401/403 (token non valido o
 * scope insufficiente). Gli altri status riportano lo stato e il corpo troncato.
 */
export async function ensureListResponse(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const text = (await response.text().catch(() => "")).slice(0, 500);
  if (response.status === 401) {
    throw new GitProviderError(
      `${provider}: autenticazione fallita (401), token non valido o scaduto`,
      401,
      text
    );
  }
  if (response.status === 403) {
    throw new GitProviderError(
      `${provider}: accesso negato (403), il token non ha gli scope necessari per elencare i repository`,
      403,
      text
    );
  }
  if (response.status === 404) {
    throw new GitProviderError(
      `${provider}: risorsa non trovata (404), verifica lo slug del workspace o del repository`,
      404,
      text
    );
  }
  if (response.status === 410) {
    throw new GitProviderError(
      `${provider}: endpoint non disponibile (410), l'API usata è stata dismessa dal provider`,
      410,
      text
    );
  }
  throw new GitProviderError(
    `${provider} API request failed with status ${response.status}: ${text}`,
    response.status,
    text
  );
}

/** Throws GitProviderError if the response is non-2xx. */
export async function ensureOkResponse(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  const text = (await response.text().catch(() => "")).slice(0, 500);
  throw new GitProviderError(
    `${provider} API request failed with status ${response.status}: ${text}`,
    response.status,
    text
  );
}

/** Cosa manca al token quando la scrittura di uno status di commit riceve
 * 401/403. Senza segreti: nomina i permessi, mai il token. */
export const COMMIT_STATUS_PERMISSION_HINT =
  "il token deve poter scrivere gli status di commit (GitHub: Commit statuses write; Bitbucket: repository write)";

/** Cosa manca al token quando la pubblicazione del verdetto di una review
 * (approvare / chiedere modifiche, e il commento che lo accompagna) riceve
 * 401/403. Senza segreti: nomina i permessi, mai il token. */
export const PR_REVIEW_PERMISSION_HINT =
  "il token deve poter revisionare le pull request (GitHub: Pull requests write; Bitbucket: pullrequest write)";

/**
 * Se `error` è un {@link GitProviderError} 401/403, ne restituisce una copia
 * col messaggio che nomina il permesso mancante (`hint`); altrimenti
 * restituisce `error` invariato. Lo status HTTP resta quello vero.
 */
export function withPermissionHint(error: unknown, hint: string): unknown {
  if (error instanceof GitProviderError && (error.status === 401 || error.status === 403)) {
    return new GitProviderError(`${error.message} — ${hint}`, error.status, error.responseText);
  }
  return error;
}

/**
 * Come {@link ensureOkResponse}, ma su 401/403 il messaggio dice quale
 * permesso manca (`hint`): un "403" nudo nel log non spiega che cosa va
 * aggiunto al token.
 */
export async function ensureOkResponseWithHint(
  response: Response,
  provider: string,
  hint: string
): Promise<void> {
  try {
    await ensureOkResponse(response, provider);
  } catch (error) {
    throw withPermissionHint(error, hint);
  }
}

/**
 * Come {@link ensureOkResponse}, ma su 401/403 il messaggio dice quale
 * permesso manca ({@link COMMIT_STATUS_PERMISSION_HINT}): lo status di commit
 * è l'unica scrittura della review che un token in sola lettura non può fare,
 * e un "403" nudo nel log non lo spiega. Lo status HTTP resta quello vero.
 */
export async function ensureCommitStatusResponse(response: Response, provider: string): Promise<void> {
  await ensureOkResponseWithHint(response, provider, COMMIT_STATUS_PERMISSION_HINT);
}

/**
 * Esegue una fetch GET con un timeout (default 10s) via AbortController. A
 * differenza di `ensureOkResponse`, non lancia sui non-2xx: restituisce la
 * Response così che il chiamante possa ispezionare lo status. Lancia solo su
 * errore di rete o timeout (gestito dal chiamante in validateCredentials).
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Estrae l'URL `rel="next"` dall'header Link in stile GitHub
 * (`<url>; rel="next", <url2>; rel="prev"`), o null se assente. Usato per
 * paginare gli elenchi GitHub di repository e branch.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Verifica che l'URL di una pagina da seguire stia sull'host dell'API del
 * provider, PRIMA di mandargli una richiesta con l'header `Authorization`.
 *
 * L'URL della pagina successiva lo decide la RISPOSTA (il `next` del JSON di
 * Bitbucket, il `Link rel="next"` di GitHub): se puntasse altrove, seguirlo
 * consegnerebbe il token a un host scelto da chi ha scritto quella risposta.
 * Il confronto è sull'`origin` calcolata da `new URL`, mai su un prefisso di
 * stringa: `https://api.bitbucket.org.evil.com` e
 * `https://api.bitbucket.org@evil.com` iniziano entrambi come l'API vera, ma
 * la loro origin è quella di `evil.com`. Si rifiutano anche l'`http:` e le
 * credenziali incorporate nell'URL (userinfo), pure sull'host giusto.
 *
 * Non combacia → lancia GitProviderError: mai risultati parziali in silenzio.
 * Il messaggio mostra solo l'origin ricevuta (niente percorso né query, che
 * potrebbero portare credenziali), e l'origin non include mai lo userinfo.
 */
export function assertPageOnApiHost(url: string, expectedOrigin: string, providerName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitProviderError(
      `${providerName} ha indicato una pagina successiva con un URL non valido: non la seguo`,
      0,
      ""
    );
  }
  const expected = new URL(expectedOrigin).origin;
  const ok =
    parsed.protocol === "https:" &&
    parsed.origin === expected &&
    parsed.username === "" &&
    parsed.password === "";
  if (!ok) {
    throw new GitProviderError(
      `${providerName} ha indicato una pagina successiva su un host inatteso (${parsed.origin}, atteso ${expected}): non la seguo per non inviare il token altrove`,
      0,
      ""
    );
  }
}

/** Codifica `user:pass` in un header Authorization Basic. */
export function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * Reads a response body as JSON, throwing GitProviderError (instead of a raw
 * SyntaxError) when the body is not valid JSON.
 */
export async function readJsonResponse(response: Response, provider: string): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const truncated = text.slice(0, 500);
    throw new GitProviderError(
      `${provider} API returned a non-JSON response body (status ${response.status}): ${truncated}`,
      response.status,
      truncated
    );
  }
}

/**
 * URL web del commit sul provider, per linkarlo dalla UI. GitHub usa
 * `/commit/<sha>`, Bitbucket `/commits/<sha>` (plurale). Restituisce null se
 * `repoUrl` non è parsabile (repo configurati a mano, URL ssh): il chiamante
 * mostra il solo sha senza link invece di rompersi.
 */
export function commitWebUrl(
  provider: GitProviderKind,
  repoUrl: string,
  sha: string,
): string | null {
  if (sha.length === 0) return null;
  let parsed: ParsedRepoUrl;
  try {
    parsed = parseRepoUrl(repoUrl);
  } catch {
    return null;
  }
  const path = provider === "github" ? "commit" : "commits";
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/${path}/${sha}`;
}
