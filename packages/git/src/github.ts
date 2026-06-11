import {
  basicAuthHeader,
  ensureOkResponse,
  fetchWithTimeout,
  getHeader,
  GitProviderError,
  parseRepoUrl,
  readJsonResponse,
  verifyHmacSignature,
  type CredentialCheck,
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

  async validateCredentials(
    p: ProjectGitConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const { token } = p.credentials;

    // Check 1 — accesso git in push. info/refs di git-receive-pack richiede il
    // permesso di scrittura; GitHub autentica i git smart-http endpoints con
    // Basic x-access-token:token (Bearer è inaffidabile per questi endpoint).
    const gitCheck = await this.probe(async () => {
      const r = await fetchWithTimeout(
        fetchImpl,
        `https://github.com/${owner}/${repo}.git/info/refs?service=git-receive-pack`,
        { headers: { Authorization: basicAuthHeader("x-access-token", token) } }
      );
      if (r.status === 200) {
        return { name: "Accesso git (push)", ok: true, detail: "autenticazione git e push ok" };
      }
      if (r.status === 401 || r.status === 403) {
        return {
          name: "Accesso git (push)",
          ok: false,
          detail: `autenticazione git fallita (status ${r.status}): verifica il token e lo scope Contents: Read and write`,
        };
      }
      return {
        name: "Accesso git (push)",
        ok: false,
        detail: `risposta inattesa dall'endpoint git (status ${r.status})`,
      };
    }, "Accesso git (push)");

    // Check 2 — accesso al repo via REST + permessi di scrittura. Un 200 con
    // permissions.push === true conferma l'accesso e la scrittura; il permesso
    // di aprire PR discende da push + lo scope Pull requests del PAT.
    const prCheck = await this.probe(async () => {
      const r = await fetchWithTimeout(fetchImpl, `${API_BASE}/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 200) {
        const body = (await r.json().catch(() => null)) as { permissions?: { push?: unknown } } | null;
        if (body?.permissions?.push === true) {
          return { name: "Permessi repository (PR)", ok: true, detail: "accesso al repo e permessi di scrittura ok" };
        }
        return {
          name: "Permessi repository (PR)",
          ok: false,
          detail: "il token non ha permessi di scrittura sul repository",
        };
      }
      if (r.status === 401) {
        return { name: "Permessi repository (PR)", ok: false, detail: "token non valido (401)" };
      }
      if (r.status === 403 || r.status === 404) {
        return {
          name: "Permessi repository (PR)",
          ok: false,
          detail: `accesso al repository negato (status ${r.status}): verifica il token e che abbia accesso a questo repo`,
        };
      }
      return {
        name: "Permessi repository (PR)",
        ok: false,
        detail: `risposta inattesa dalla REST API (status ${r.status})`,
      };
    }, "Permessi repository (PR)");

    return [gitCheck, prCheck];
  }

  /** Esegue una sonda restituendo un CredentialCheck, trasformando gli errori di rete in `ok: false`. */
  private async probe(
    run: () => Promise<CredentialCheck>,
    name: string
  ): Promise<CredentialCheck> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, ok: false, detail: `errore di rete: ${message}` };
    }
  }
}
