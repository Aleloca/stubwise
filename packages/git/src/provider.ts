import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitProviderKind } from "@stubwise/shared";

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

export interface PrMergedEvent {
  provider: GitProviderKind;
  /** Source branch of the merged pull request. */
  branch: string;
  prUrl: string;
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
  /**
   * Returns a PrMergedEvent if the webhook payload represents a merged PR,
   * otherwise null. Never throws on malformed input. Does NOT verify the
   * signature — call verifyWebhook first.
   */
  parseWebhook(headers: Record<string, string>, body: unknown): PrMergedEvent | null;
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
    credentials: AccountCredentials,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<CredentialCheck[]>;
  /**
   * Registra in modo idempotente il webhook PR-merged sul provider git usando
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
  listRepositories(p: AccountCredentials, opts?: { fetchImpl?: FetchLike }): Promise<RepoSummary[]>;
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
