import {
  basicAuthHeader,
  ensureListResponse,
  ensureOkResponse,
  fetchWithTimeout,
  getHeader,
  GitProviderError,
  parseNextLink,
  parseRepoUrl,
  readJsonResponse,
  verifyHmacSignature,
  type AccountCredentials,
  type CredentialCheck,
  type FetchLike,
  type GitProvider,
  type GitProviderOptions,
  type PrMergedEvent,
  type ProjectGitConfig,
  type RepoSummary,
  type WebhookResult,
} from "./provider.js";

const API_BASE = "https://api.github.com";

/**
 * Tetto di repository elencati: ~3 pagine da 100. Oltre questa soglia la UI
 * di scelta repo diventa comunque ingestibile; l'utente può sempre incollare
 * l'URL a mano. Evita anche un loop infinito se il Link `next` non termina.
 */
const MAX_REPO_PAGES = 3;

/** Tetto di branch elencati: ~2 pagine da 100. */
const MAX_BRANCH_PAGES = 2;

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

    // Check 3 — accesso ai webhook (config automatica). Conferma almeno la
    // lettura della lista hook (Bearer): scrivere richiede admin:repo_hook /
    // "Webhooks: write", ma la lettura è un buon proxy ed è advisory.
    const webhookCheck = await this.probe(async () => {
      const r = await fetchWithTimeout(fetchImpl, `${API_BASE}/repos/${owner}/${repo}/hooks?per_page=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 200) {
        return {
          name: "Accesso webhook (config automatica)",
          ok: true,
          detail: "scope webhook presente",
        };
      }
      if (r.status === 403 || r.status === 404) {
        return {
          name: "Accesso webhook (config automatica)",
          ok: false,
          detail:
            "403/404: o manca il permesso webhook sul token (admin:repo_hook classico o Webhooks: write fine-grained), oppure l'account non ha accesso Admin al repository per gestire i webhook",
        };
      }
      return {
        name: "Accesso webhook (config automatica)",
        ok: false,
        detail: `risposta inattesa dall'endpoint webhook (status ${r.status})`,
      };
    }, "Accesso webhook (config automatica)");

    return [gitCheck, prCheck, webhookCheck];
  }

  async validateAccount(
    p: AccountCredentials,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { token } = p.credentials;

    const check = await this.probe(async () => {
      const r = await fetchWithTimeout(fetchImpl, `${API_BASE}/user/repos?per_page=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 200) {
        return {
          name: "Autenticazione e accesso repository",
          ok: true,
          detail: "token valido, accesso ai repository ok",
        };
      }
      if (r.status === 401) {
        return {
          name: "Autenticazione e accesso repository",
          ok: false,
          detail: "token non valido (401)",
        };
      }
      if (r.status === 403) {
        return {
          name: "Autenticazione e accesso repository",
          ok: false,
          detail: "accesso negato (403): verifica gli scope del token",
        };
      }
      return {
        name: "Autenticazione e accesso repository",
        ok: false,
        detail: `risposta inattesa (status ${r.status})`,
      };
    }, "Autenticazione e accesso repository");

    return [check];
  }

  async ensureWebhook(
    p: ProjectGitConfig,
    hook: { url: string; secret: string },
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<WebhookResult> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    const config = { url: hook.url, content_type: "json", secret: hook.secret, insecure_ssl: "0" };
    const base = `${API_BASE}/repos/${owner}/${repo}/hooks`;

    try {
      const listResponse = await fetchImpl(base, { method: "GET", headers });
      this.guardWebhookResponse(listResponse);
      const list = (await readJsonResponse(listResponse, "GitHub")) as {
        id?: unknown;
        config?: { url?: unknown };
      }[];
      const existing = Array.isArray(list)
        ? list.find((h) => h.config?.url === hook.url)
        : undefined;

      if (existing && typeof existing.id === "number") {
        const updateResponse = await fetchImpl(`${base}/${existing.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ active: true, events: ["pull_request"], config }),
        });
        this.guardWebhookResponse(updateResponse);
        return { created: false, updated: true, id: String(existing.id), detail: "Webhook aggiornato" };
      }

      const createResponse = await fetchImpl(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "web", active: true, events: ["pull_request"], config }),
      });
      this.guardWebhookResponse(createResponse);
      const created = (await readJsonResponse(createResponse, "GitHub")) as { id?: unknown };
      const id = typeof created.id === "number" ? String(created.id) : "";
      return { created: true, updated: false, id, detail: "Webhook configurato" };
    } catch (error) {
      if (error instanceof GitProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitProviderError(`Errore di rete configurando il webhook GitHub: ${message}`, 0, "");
    }
  }

  async listRepositories(
    p: AccountCredentials,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<RepoSummary[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
    };
    let url: string | null =
      `${API_BASE}/user/repos?per_page=100&sort=updated&affiliation=${encodeURIComponent("owner,collaborator,organization_member")}`;
    const repos: RepoSummary[] = [];
    for (let pageNumber = 0; pageNumber < MAX_REPO_PAGES && url; pageNumber++) {
      const response = await fetchImpl(url, { method: "GET", headers });
      await ensureListResponse(response, "GitHub");
      const link = response.headers.get("link");
      const page = (await readJsonResponse(response, "GitHub")) as {
        full_name?: unknown;
        name?: unknown;
        clone_url?: unknown;
        default_branch?: unknown;
      }[];
      if (!Array.isArray(page)) break;
      for (const r of page) {
        if (typeof r.full_name !== "string" || typeof r.name !== "string" || typeof r.clone_url !== "string") {
          continue;
        }
        repos.push({
          fullName: r.full_name,
          name: r.name,
          cloneUrl: r.clone_url,
          defaultBranch: typeof r.default_branch === "string" ? r.default_branch : null,
        });
      }
      url = parseNextLink(link);
    }
    return repos;
  }

  async listBranches(
    p: AccountCredentials,
    repoFullName: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<{ branches: string[]; defaultBranch: string | null }> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
    };

    // Branch di default: dal repo stesso.
    const repoResponse = await fetchImpl(`${API_BASE}/repos/${repoFullName}`, { method: "GET", headers });
    await ensureListResponse(repoResponse, "GitHub");
    const repo = (await readJsonResponse(repoResponse, "GitHub")) as { default_branch?: unknown };
    const defaultBranch = typeof repo.default_branch === "string" ? repo.default_branch : null;

    // Elenco branch (paginato col Link header, fino al tetto).
    let url: string | null = `${API_BASE}/repos/${repoFullName}/branches?per_page=100`;
    const branches: string[] = [];
    for (let pageNumber = 0; pageNumber < MAX_BRANCH_PAGES && url; pageNumber++) {
      const response = await fetchImpl(url, { method: "GET", headers });
      await ensureListResponse(response, "GitHub");
      const link = response.headers.get("link");
      const page = (await readJsonResponse(response, "GitHub")) as { name?: unknown }[];
      if (!Array.isArray(page)) break;
      for (const b of page) {
        if (typeof b.name === "string") branches.push(b.name);
      }
      url = parseNextLink(link);
    }
    return { branches, defaultBranch };
  }

  /**
   * Lancia GitProviderError sui non-2xx delle chiamate webhook, con messaggio
   * dedicato sul 403/404 (permesso webhook mancante).
   */
  private guardWebhookResponse(response: Response): void {
    if (response.ok) return;
    if (response.status === 403 || response.status === 404) {
      throw new GitProviderError(
        "il token non ha il permesso webhook: serve admin:repo_hook (PAT classico) o il permesso \"Webhooks: write\" (token fine-grained)",
        response.status,
        ""
      );
    }
    throw new GitProviderError(
      `GitHub API request failed with status ${response.status} configurando il webhook`,
      response.status,
      ""
    );
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
