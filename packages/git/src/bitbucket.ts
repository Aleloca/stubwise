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

const API_BASE = "https://api.bitbucket.org/2.0";

interface BitbucketPrResponse {
  links?: { html?: { href?: unknown } };
}

export class BitbucketProvider implements GitProvider {
  private readonly fetchImpl: FetchLike;

  constructor(options: GitProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getCloneUrl(p: ProjectGitConfig): string {
    const { host, owner, repo } = parseRepoUrl(p.repoUrl);
    const { username, token } = this.requireCredentials(p);
    return `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${host}/${owner}/${repo}.git`;
  }

  getAuthHeader(p: ProjectGitConfig): string {
    const { username, token } = this.requireCredentials(p);
    return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  }

  async openPullRequest(
    p: ProjectGitConfig,
    pr: { branch: string; title: string; body: string }
  ): Promise<{ url: string }> {
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const { username, token } = this.requireCredentials(p);
    const response = await this.fetchImpl(`${API_BASE}/repositories/${owner}/${repo}/pullrequests`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: pr.title,
        description: pr.body,
        source: { branch: { name: pr.branch } },
        destination: { branch: { name: p.defaultBranch } },
      }),
    });
    await ensureOkResponse(response, "Bitbucket");
    const data = (await readJsonResponse(response, "Bitbucket")) as BitbucketPrResponse;
    const url = data.links?.html?.href;
    if (typeof url !== "string") {
      throw new GitProviderError(
        "Bitbucket API response is missing links.html.href",
        response.status,
        JSON.stringify(data).slice(0, 500)
      );
    }
    return { url };
  }

  parseWebhook(headers: Record<string, string>, body: unknown): PrMergedEvent | null {
    if (getHeader(headers, "x-event-key") !== "pullrequest:fulfilled") return null;
    if (typeof body !== "object" || body === null) return null;
    const pullrequest = (body as { pullrequest?: unknown }).pullrequest;
    if (typeof pullrequest !== "object" || pullrequest === null) return null;
    const pr = pullrequest as {
      source?: { branch?: { name?: unknown } };
      links?: { html?: { href?: unknown } };
    };
    const branch = pr.source?.branch?.name;
    const prUrl = pr.links?.html?.href;
    if (typeof branch !== "string" || typeof prUrl !== "string") return null;
    return { provider: "bitbucket", branch, prUrl };
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string | Buffer, secret: string): boolean {
    return verifyHmacSignature(getHeader(headers, "x-hub-signature"), rawBody, secret);
  }

  private requireCredentials(p: ProjectGitConfig): { username: string; token: string } {
    const { username, token } = p.credentials;
    if (!username) {
      throw new Error("Bitbucket credentials require a username (app passwords are username-scoped)");
    }
    return { username, token };
  }
}
