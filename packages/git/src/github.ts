import {
  ensureOkResponse,
  getHeader,
  GitProviderError,
  parseRepoUrl,
  readJsonResponse,
  verifyHmacSignature,
  type FetchLike,
  type GitProvider,
  type GitProviderOptions,
  type PrMergedEvent,
  type ProjectGitConfig,
} from "./provider.js";

const API_BASE = "https://api.github.com";

export class GitHubProvider implements GitProvider {
  private readonly fetchImpl: FetchLike;

  constructor(options: GitProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getCloneUrl(p: ProjectGitConfig): string {
    const { host, owner, repo } = parseRepoUrl(p.repoUrl);
    return `https://x-access-token:${encodeURIComponent(p.credentials.token)}@${host}/${owner}/${repo}.git`;
  }

  getAuthHeader(p: ProjectGitConfig): string {
    return `Basic ${Buffer.from(`x-access-token:${p.credentials.token}`).toString("base64")}`;
  }

  async openPullRequest(
    p: ProjectGitConfig,
    pr: { branch: string; title: string; body: string }
  ): Promise<{ url: string }> {
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await this.fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: pr.title,
        body: pr.body,
        head: pr.branch,
        base: p.defaultBranch,
      }),
    });
    await ensureOkResponse(response, "GitHub");
    const data = (await readJsonResponse(response, "GitHub")) as { html_url?: unknown };
    if (typeof data.html_url !== "string") {
      throw new GitProviderError(
        "GitHub API response is missing html_url",
        response.status,
        JSON.stringify(data).slice(0, 500)
      );
    }
    return { url: data.html_url };
  }

  parseWebhook(headers: Record<string, string>, body: unknown): PrMergedEvent | null {
    if (getHeader(headers, "x-github-event") !== "pull_request") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { action?: unknown; pull_request?: unknown };
    if (payload.action !== "closed") return null;
    if (typeof payload.pull_request !== "object" || payload.pull_request === null) return null;
    const pr = payload.pull_request as { merged?: unknown; head?: { ref?: unknown }; html_url?: unknown };
    if (pr.merged !== true) return null;
    const branch = pr.head?.ref;
    const prUrl = pr.html_url;
    if (typeof branch !== "string" || typeof prUrl !== "string") return null;
    return { provider: "github", branch, prUrl };
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string | Buffer, secret: string): boolean {
    return verifyHmacSignature(getHeader(headers, "x-hub-signature-256"), rawBody, secret);
  }
}
