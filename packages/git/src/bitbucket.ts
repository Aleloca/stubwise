import {
  basicAuthHeader,
  ensureListResponse,
  ensureOkResponse,
  fetchWithTimeout,
  getHeader,
  GitProviderError,
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

const API_BASE = "https://api.bitbucket.org/2.0";

/** Tetto di repository elencati: ~3 pagine da 100 (~300 repo), seguendo il
 * cursore `next` di Bitbucket. Vedi MAX_REPO_PAGES di github.ts per la logica. */
const MAX_REPO_PAGES = 3;

/** Tetto di branch elencati: ~2 pagine da 100 (~200 branch). */
const MAX_BRANCH_PAGES = 2;

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
    // REST identity: Bitbucket API tokens authenticate on api.bitbucket.org as
    // the Atlassian EMAIL (not the git username). Legacy app passwords have no
    // email and authenticate as the username, so we fall back to it.
    const { email, username, token } = p.credentials;
    const restUser = email ?? username;
    if (!restUser) {
      throw new GitProviderError(
        "Bitbucket REST credentials require an email (API tokens) or a username (legacy app passwords)",
        0,
        ""
      );
    }
    const response = await this.fetchImpl(`${API_BASE}/repositories/${owner}/${repo}/pullrequests`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${restUser}:${token}`).toString("base64")}`,
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

  async validateCredentials(
    p: ProjectGitConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const { username, email, token } = p.credentials;

    // Check 1 — accesso git in push. info/refs di git-receive-pack richiede il
    // permesso di scrittura: un 200 conferma la capacità di push. Identità git
    // = username Bitbucket:token (gli API token e le app password legacy usano
    // l'username, non l'email).
    const gitCheck: CredentialCheck = !username
      ? {
          name: "Accesso git (push)",
          ok: false,
          detail: "username Bitbucket mancante (serve per l'autenticazione git)",
        }
      : await this.probe("Accesso git (push)", async () => {
          const r = await fetchWithTimeout(
            fetchImpl,
            `https://bitbucket.org/${owner}/${repo}.git/info/refs?service=git-receive-pack`,
            { headers: { Authorization: basicAuthHeader(username, token) } }
          );
          if (r.status === 200) {
            return { name: "Accesso git (push)", ok: true, detail: "autenticazione git e push ok" };
          }
          if (r.status === 401 || r.status === 403) {
            return {
              name: "Accesso git (push)",
              ok: false,
              detail: `autenticazione git fallita (status ${r.status}): verifica username Bitbucket, token e scope repository:write`,
            };
          }
          return {
            name: "Accesso git (push)",
            ok: false,
            detail: `risposta inattesa dall'endpoint git (status ${r.status})`,
          };
        });

    // Check 2 — accesso REST per aprire le PR. Identità REST = email Atlassian
    // (gli API token autenticano su api.bitbucket.org come email, non come
    // username); fallback su username per le app password legacy.
    const restUser = email ?? username;
    const restCheck: CredentialCheck = !restUser
      ? {
          name: "Accesso REST API (PR)",
          ok: false,
          detail: "email Atlassian (o username legacy) mancante: serve come identità per la REST API",
        }
      : await this.probe("Accesso REST API (PR)", async () => {
          const r = await fetchWithTimeout(
            fetchImpl,
            `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/pullrequests?pagelen=1`,
            { headers: { Authorization: basicAuthHeader(restUser, token) } }
          );
          if (r.status === 200) {
            return { name: "Accesso REST API (PR)", ok: true, detail: "accesso REST e scope pullrequest ok" };
          }
          if (r.status === 401) {
            return {
              name: "Accesso REST API (PR)",
              ok: false,
              detail:
                "autenticazione REST fallita (401): per gli API token Atlassian serve l'email come identità, e il token deve avere lo scope pullrequest",
            };
          }
          if (r.status === 403) {
            return {
              name: "Accesso REST API (PR)",
              ok: false,
              detail: "accesso negato (403): manca lo scope pullrequest",
            };
          }
          return {
            name: "Accesso REST API (PR)",
            ok: false,
            detail: `risposta inattesa dalla REST API (status ${r.status})`,
          };
        });

    // Check 3 — accesso ai webhook (config automatica). Conferma almeno la
    // lettura dell'elenco hook: lo scope di scrittura serve poi per creare/
    // aggiornare, ma la presenza in lettura è un buon proxy ed è advisory (la
    // configurazione vera e propria emergerà eventuali errori di scrittura).
    const webhookCheck: CredentialCheck = !restUser
      ? {
          name: "Accesso webhook (config automatica)",
          ok: false,
          detail: "email Atlassian (o username legacy) mancante: serve come identità per la REST API",
        }
      : await this.probe("Accesso webhook (config automatica)", async () => {
          const r = await fetchWithTimeout(
            fetchImpl,
            `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/hooks?pagelen=1`,
            { headers: { Authorization: basicAuthHeader(restUser, token) } }
          );
          if (r.status === 200) {
            return {
              name: "Accesso webhook (config automatica)",
              ok: true,
              detail: "scope webhook presente",
            };
          }
          if (r.status === 403) {
            return {
              name: "Accesso webhook (config automatica)",
              ok: false,
              detail:
                "403: o manca lo scope webhook (read/write:webhook) sul token, oppure l'account non ha accesso Admin al repository (la gestione dei webhook su Bitbucket richiede Admin, non basta Write)",
            };
          }
          return {
            name: "Accesso webhook (config automatica)",
            ok: false,
            detail: `risposta inattesa dall'endpoint webhook (status ${r.status})`,
          };
        });

    return [gitCheck, restCheck, webhookCheck];
  }

  async validateAccount(
    p: AccountCredentials,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { username, email, token } = p.credentials;

    // Identità REST = email Atlassian (gli API token autenticano su
    // api.bitbucket.org come email, non come username); fallback su username
    // per le app password legacy.
    const restUser = email ?? username;
    if (!restUser) {
      return [
        {
          name: "Autenticazione e accesso repository",
          ok: false,
          detail: "email Atlassian (o username legacy) mancante",
        },
      ];
    }

    const check = await this.probe("Autenticazione e accesso repository", async () => {
      const r = await fetchWithTimeout(
        fetchImpl,
        "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=1",
        { headers: { Authorization: basicAuthHeader(restUser, token) } }
      );
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
          detail: "autenticazione fallita (401): verifica email Atlassian e token",
        };
      }
      if (r.status === 403) {
        return {
          name: "Autenticazione e accesso repository",
          ok: false,
          detail: "manca lo scope repository (read)",
        };
      }
      return {
        name: "Autenticazione e accesso repository",
        ok: false,
        detail: `risposta inattesa (status ${r.status})`,
      };
    });

    return [check];
  }

  async ensureWebhook(
    p: ProjectGitConfig,
    hook: { url: string; secret: string },
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<WebhookResult> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const restUser = p.credentials.email ?? p.credentials.username;
    if (!restUser) {
      throw new GitProviderError(
        "Per configurare il webhook serve un'email Atlassian (API token) o uno username (app password legacy)",
        0,
        ""
      );
    }
    const auth = basicAuthHeader(restUser, p.credentials.token);
    const base = `${API_BASE}/repositories/${owner}/${repo}/hooks`;
    const body = {
      description: "Stubwise",
      url: hook.url,
      active: true,
      events: ["pullrequest:fulfilled"],
      secret: hook.secret,
    };

    try {
      // Lista (prima pagina): cerca un hook con lo stesso target URL.
      const listResponse = await fetchImpl(base, {
        method: "GET",
        headers: { Authorization: auth },
      });
      this.guardWebhookResponse(listResponse);
      const list = (await readJsonResponse(listResponse, "Bitbucket")) as {
        values?: { uuid?: unknown; url?: unknown }[];
      };
      const existing = (list.values ?? []).find((h) => h.url === hook.url);

      if (existing && typeof existing.uuid === "string") {
        const updateResponse = await fetchImpl(`${base}/${existing.uuid}`, {
          method: "PUT",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        this.guardWebhookResponse(updateResponse);
        return {
          created: false,
          updated: true,
          id: existing.uuid,
          detail: "Webhook aggiornato",
        };
      }

      const createResponse = await fetchImpl(base, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      this.guardWebhookResponse(createResponse);
      const created = (await readJsonResponse(createResponse, "Bitbucket")) as { uuid?: unknown };
      const id = typeof created.uuid === "string" ? created.uuid : "";
      return { created: true, updated: false, id, detail: "Webhook configurato" };
    } catch (error) {
      if (error instanceof GitProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitProviderError(`Errore di rete configurando il webhook Bitbucket: ${message}`, 0, "");
    }
  }

  async listRepositories(
    p: AccountCredentials,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<RepoSummary[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const auth = this.restAuthHeader(p);
    let url: string | null = `${API_BASE}/repositories?role=member&pagelen=100&sort=-updated_on`;
    const repos: RepoSummary[] = [];
    for (let pageNumber = 0; pageNumber < MAX_REPO_PAGES && url; pageNumber++) {
      const response = await fetchImpl(url, { method: "GET", headers: { Authorization: auth } });
      await ensureListResponse(response, "Bitbucket");
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        values?: {
          full_name?: unknown;
          name?: unknown;
          mainbranch?: { name?: unknown };
          links?: { clone?: { name?: unknown; href?: unknown }[] };
        }[];
        next?: unknown;
      };
      for (const r of data.values ?? []) {
        if (typeof r.full_name !== "string" || typeof r.name !== "string") continue;
        const httpsClone = (r.links?.clone ?? []).find((c) => c.name === "https");
        const cloneUrl = typeof httpsClone?.href === "string" ? httpsClone.href : "";
        repos.push({
          fullName: r.full_name,
          name: r.name,
          cloneUrl,
          defaultBranch: typeof r.mainbranch?.name === "string" ? r.mainbranch.name : null,
        });
      }
      url = typeof data.next === "string" ? data.next : null;
    }
    return repos;
  }

  async listBranches(
    p: AccountCredentials,
    repoFullName: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<{ branches: string[]; defaultBranch: string | null }> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const auth = this.restAuthHeader(p);

    // Branch di default: dal repo stesso (mainbranch.name).
    const repoResponse = await fetchImpl(`${API_BASE}/repositories/${repoFullName}`, {
      method: "GET",
      headers: { Authorization: auth },
    });
    await ensureListResponse(repoResponse, "Bitbucket");
    const repo = (await readJsonResponse(repoResponse, "Bitbucket")) as { mainbranch?: { name?: unknown } };
    const defaultBranch = typeof repo.mainbranch?.name === "string" ? repo.mainbranch.name : null;

    // Elenco branch col cursore `next`, fino al tetto.
    let url: string | null = `${API_BASE}/repositories/${repoFullName}/refs/branches?pagelen=100`;
    const branches: string[] = [];
    for (let pageNumber = 0; pageNumber < MAX_BRANCH_PAGES && url; pageNumber++) {
      const response = await fetchImpl(url, { method: "GET", headers: { Authorization: auth } });
      await ensureListResponse(response, "Bitbucket");
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        values?: { name?: unknown }[];
        next?: unknown;
      };
      for (const b of data.values ?? []) {
        if (typeof b.name === "string") branches.push(b.name);
      }
      url = typeof data.next === "string" ? data.next : null;
    }
    return { branches, defaultBranch };
  }

  /**
   * Header Basic per la REST API di Bitbucket: identità = email Atlassian (API
   * token) o, in fallback, username (app password legacy). Lancia se manca
   * entrambe. Stessa regola di openPullRequest/validateCredentials.
   */
  private restAuthHeader(p: AccountCredentials): string {
    const restUser = p.credentials.email ?? p.credentials.username;
    if (!restUser) {
      throw new GitProviderError(
        "Per elencare i repository Bitbucket serve un'email Atlassian (API token) o uno username (app password legacy)",
        0,
        ""
      );
    }
    return basicAuthHeader(restUser, p.credentials.token);
  }

  /**
   * Lancia GitProviderError sui non-2xx delle chiamate webhook, con messaggio
   * dedicato sul 403 (scope webhook mancante). Il chiamante ensureWebhook
   * cattura solo gli errori di rete grezzi; questo invece propaga GitProviderError.
   */
  private guardWebhookResponse(response: Response): void {
    if (response.ok) return;
    if (response.status === 403) {
      throw new GitProviderError(
        "403 dalla gestione webhook: verifica che il token abbia gli scope read:webhook e write:webhook, E che l'account abbia accesso Admin al repository (Bitbucket richiede Admin per gestire i webhook, non basta Write)",
        403,
        ""
      );
    }
    throw new GitProviderError(
      `Bitbucket API request failed with status ${response.status} configurando il webhook`,
      response.status,
      ""
    );
  }

  /** Esegue una sonda restituendo un CredentialCheck, trasformando gli errori di rete in `ok: false`. */
  private async probe(name: string, run: () => Promise<CredentialCheck>): Promise<CredentialCheck> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, ok: false, detail: `errore di rete: ${message}` };
    }
  }

  private requireCredentials(p: ProjectGitConfig): { username: string; token: string } {
    const { username, token } = p.credentials;
    if (!username) {
      throw new Error("Bitbucket credentials require a username (app passwords are username-scoped)");
    }
    return { username, token };
  }
}
