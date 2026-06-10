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
    /** Required for Bitbucket app passwords; unused by GitHub. */
    username?: string;
    token: string;
  };
}

export interface PrMergedEvent {
  provider: GitProviderKind;
  /** Source branch of the merged pull request. */
  branch: string;
  prUrl: string;
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
