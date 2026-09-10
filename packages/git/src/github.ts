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
  rollupCheckStatus,
  verifyHmacSignature,
  MergeNotAllowedError,
  type AccountConfig,
  type AccountCredentials,
  type CheckOutcomeStatus,
  type CredentialCheck,
  type FetchLike,
  type GitProvider,
  type GitProviderOptions,
  type PrActivityEvent,
  type ProjectGitConfig,
  type PullRequestChecks,
  type PushWebhookEvent,
  type RepoSummary,
  type WebhookEvent,
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

  /** Stato attuale della PR via REST: 'open' se ancora aperta, altrimenti 'closed'. */
  async getPullRequestState(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<"open" | "closed"> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    await ensureOkResponse(response, "GitHub");
    const data = (await readJsonResponse(response, "GitHub")) as { state?: unknown };
    return data.state === "open" ? "open" : "closed";
  }

  /**
   * Check-run di GitHub Actions sull'ULTIMO commit della PR (`head.sha`, letto
   * dalla stessa risposta di `getPullRequestState`, una richiesta in più per
   * la resa: la lista dei check-run vive per commit, non per PR). Mai lancia:
   * un errore prima di aver risolto la PR (rete, 401, PR non trovata) ricade
   * su `{ status: "unknown", checks: [] }` (fase 8, review fix Task 2) — un
   * corpo malformato SUL check-runs, dopo aver risolto la PR, ricade sullo
   * stesso `unknown` ma con `headSha` già valorizzato. `headSha` (fase 8,
   * review fix Task 4) è la stessa risoluzione, riusata dal chiamante per
   * "questa PR è già su un ambiente?" senza una chiamata in più.
   */
  async getPullRequestChecks(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<PullRequestChecks> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
    };
    let headSha: string | undefined;
    let headRef: string | undefined;
    try {
      const prResponse = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
        method: "GET",
        headers,
      });
      await ensureOkResponse(prResponse, "GitHub");
      const pr = (await readJsonResponse(prResponse, "GitHub")) as {
        head?: { sha?: unknown; ref?: unknown };
      };
      const resolvedHeadSha = pr.head?.sha;
      if (typeof resolvedHeadSha !== "string") return { status: "unknown", checks: [] };
      headSha = resolvedHeadSha;
      if (typeof pr.head?.ref === "string") headRef = pr.head.ref;
      const extra = { headSha, ...(headRef !== undefined ? { headRef } : {}) };

      const checksResponse = await fetchImpl(
        `${API_BASE}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        { method: "GET", headers }
      );
      await ensureOkResponse(checksResponse, "GitHub");
      const data = (await readJsonResponse(checksResponse, "GitHub")) as {
        check_runs?: { name?: unknown; status?: unknown; conclusion?: unknown }[];
      };
      const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
      if (runs.length === 0) return { status: "no_checks", checks: [], ...extra };

      const checks = runs.map((run) => ({
        name: typeof run.name === "string" ? run.name : "check",
        status: githubCheckStatus(run.status, run.conclusion),
      }));
      return { status: rollupCheckStatus(checks), checks, ...extra };
    } catch {
      return {
        status: "unknown",
        checks: [],
        ...(headSha !== undefined ? { headSha } : {}),
        ...(headRef !== undefined ? { headRef } : {}),
      };
    }
  }

  /**
   * Mergia la PR (fase 8, Task 8). `PUT .../merge` con `merge_method: "merge"`
   * (merge commit — nessuna riscrittura di storia sul branch dell'utente).
   * Mappa gli status di errore reali dell'API GitHub: 405 = non mergiabile
   * (branch protection, review mancanti); 409 = testa cambiata dopo l'ultimo
   * check (conflitto/stale, l'utente riprova); 403/404 = permesso mancante o
   * PR inaccessibile.
   */
  async mergePullRequest(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<{ merged: true; sha: string }> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: "merge" }),
    });

    if (response.ok) {
      const data = (await readJsonResponse(response, "GitHub")) as { sha?: unknown; merged?: unknown };
      if (data.merged === true && typeof data.sha === "string") {
        return { merged: true, sha: data.sha };
      }
      throw new MergeNotAllowedError(
        "unknown",
        "GitHub merge response is missing sha/merged=true",
        response.status,
        JSON.stringify(data).slice(0, 500)
      );
    }

    const bodyText = await response.text().catch(() => "");
    if (response.status === 405) {
      throw new MergeNotAllowedError(
        "not_mergeable",
        "GitHub: la PR non è mergiabile (conflitti o regole del branch non soddisfatte)",
        405,
        bodyText.slice(0, 500)
      );
    }
    if (response.status === 409) {
      throw new MergeNotAllowedError(
        "not_mergeable",
        "GitHub: il ramo di base è cambiato dopo l'ultimo controllo, riprova",
        409,
        bodyText.slice(0, 500)
      );
    }
    if (response.status === 403) {
      throw new MergeNotAllowedError(
        "forbidden",
        "GitHub: il token non ha il permesso di mergiare questa PR",
        403,
        bodyText.slice(0, 500)
      );
    }
    if (response.status === 404) {
      throw new MergeNotAllowedError(
        "forbidden",
        "GitHub: PR non trovata o non accessibile con queste credenziali",
        404,
        bodyText.slice(0, 500)
      );
    }
    throw new MergeNotAllowedError(
      "unknown",
      `GitHub merge fallito con status ${response.status}`,
      response.status,
      bodyText.slice(0, 500)
    );
  }

  /**
   * Commento "sticky" della review: cerca tra gli issue comment della PR (su
   * GitHub i commenti di conversazione delle PR sono issue comment) quello che
   * contiene `marker` e lo aggiorna (PATCH), altrimenti ne crea uno (POST).
   */
  async upsertPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    marker: string,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    // Una pagina da 100 basta: il commento sticky è tra i primi della PR.
    const listResponse = await fetchImpl(
      `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      { method: "GET", headers }
    );
    await ensureOkResponse(listResponse, "GitHub");
    const list = (await readJsonResponse(listResponse, "GitHub")) as {
      id?: unknown;
      body?: unknown;
    }[];
    const existing = Array.isArray(list)
      ? list.find((c) => typeof c.body === "string" && c.body.includes(marker))
      : undefined;
    const target =
      existing && typeof existing.id === "number"
        ? { url: `${API_BASE}/repos/${owner}/${repo}/issues/comments/${existing.id}`, method: "PATCH" }
        : { url: `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`, method: "POST" };
    const response = await fetchImpl(target.url, {
      method: target.method,
      headers,
      body: JSON.stringify({ body }),
    });
    await ensureOkResponse(response, "GitHub");
  }

  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent | null {
    if (getHeader(headers, "x-github-event") !== "pull_request") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { action?: unknown; pull_request?: unknown };
    if (payload.action !== "closed") return null;
    if (typeof payload.pull_request !== "object" || payload.pull_request === null) return null;
    const pr = payload.pull_request as {
      number?: unknown;
      merged?: unknown;
      head?: { ref?: unknown };
      html_url?: unknown;
    };
    const branch = pr.head?.ref;
    const prUrl = pr.html_url;
    if (typeof branch !== "string" || typeof prUrl !== "string") return null;
    const kind = pr.merged === true ? "merged" : "closed_unmerged";
    // Numero mancante o malformato: l'evento di chiusura resta valido (serve
    // alla chiusura del ticket via branch), solo il cleanup review lo salta.
    const prNumber = typeof pr.number === "number" ? pr.number : null;
    return { kind, provider: "github", branch, prUrl, prNumber };
  }

  /**
   * Eventi PR opened/reopened/synchronize per l'automazione PR Review:
   * opened e reopened diventano `opened`, synchronize (push sulla source
   * branch) diventa `updated`. Ogni altro action (closed, edited, ...) e ogni
   * body malformato restituiscono null, senza mai lanciare.
   */
  parsePrEvent(headers: Record<string, string>, body: unknown): PrActivityEvent | null {
    if (getHeader(headers, "x-github-event") !== "pull_request") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { action?: unknown; pull_request?: unknown };
    const kind =
      payload.action === "opened" || payload.action === "reopened"
        ? "opened"
        : payload.action === "synchronize"
          ? "updated"
          : null;
    if (kind === null) return null;
    if (typeof payload.pull_request !== "object" || payload.pull_request === null) return null;
    const pr = payload.pull_request as {
      number?: unknown;
      title?: unknown;
      body?: unknown;
      html_url?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
    };
    if (
      typeof pr.number !== "number" ||
      typeof pr.title !== "string" ||
      typeof pr.html_url !== "string" ||
      typeof pr.head?.ref !== "string" ||
      typeof pr.head?.sha !== "string" ||
      typeof pr.base?.ref !== "string"
    ) {
      return null;
    }
    return {
      kind,
      provider: "github",
      prNumber: pr.number,
      title: pr.title,
      description: typeof pr.body === "string" ? pr.body : "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      headSha: pr.head.sha,
      prUrl: pr.html_url,
    };
  }

  parsePushEvent(headers: Record<string, string>, body: unknown): PushWebhookEvent | null {
    if (getHeader(headers, "x-github-event") !== "push") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { ref?: unknown; before?: unknown; after?: unknown; commits?: unknown };
    if (typeof payload.ref !== "string") return null;
    const prefix = "refs/heads/";
    // Solo i push di branch: i tag (refs/tags/...) e altri ref non interessano.
    if (!payload.ref.startsWith(prefix)) return null;
    const branch = payload.ref.slice(prefix.length);
    if (branch.length === 0) return null;
    if (typeof payload.before !== "string" || typeof payload.after !== "string") return null;
    const commits = Array.isArray(payload.commits)
      ? payload.commits.flatMap((c) => {
          if (typeof c !== "object" || c === null) return [];
          const commit = c as { id?: unknown; message?: unknown };
          if (typeof commit.id !== "string" || typeof commit.message !== "string") return [];
          return [{ sha: commit.id, message: commit.message }];
        })
      : [];
    return { branch, beforeSha: payload.before, afterSha: payload.after, commits };
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
    // di aprire PR E DI MERGIARLE (fase 8, Task 8) discendono ENTRAMBI da push +
    // lo scope Pull requests del PAT — GitHub non espone un bit "merge" a sé:
    // è lo stesso segnale, dichiarato per intero invece di lasciarlo scoperto
    // ("senza questo, lo scopriresti al primo tentativo", design fase 8 §4).
    const prCheck = await this.probe(async () => {
      const r = await fetchWithTimeout(fetchImpl, `${API_BASE}/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 200) {
        const body = (await r.json().catch(() => null)) as { permissions?: { push?: unknown } } | null;
        if (body?.permissions?.push === true) {
          return {
            name: "Permessi repository (PR e merge)",
            ok: true,
            // Dice cosa è stato VERIFICATO, non cosa GARANTISCE (fase 8,
            // review fix Task 4): push:true è necessario per mergiare ma non
            // basta — branch protection, review obbligatorie e required
            // checks possono ancora bloccare un merge specifico, e questo
            // check non li vede (GitHub non li espone su questo endpoint).
            detail: "accesso al repo e permessi di scrittura ok — branch protection e review obbligatorie, se presenti, si verificano solo al momento del merge",
          };
        }
        return {
          name: "Permessi repository (PR e merge)",
          ok: false,
          detail: "il token non ha permessi di scrittura sul repository (serve anche per mergiare le PR)",
        };
      }
      if (r.status === 401) {
        return { name: "Permessi repository (PR e merge)", ok: false, detail: "token non valido (401)" };
      }
      if (r.status === 403 || r.status === 404) {
        return {
          name: "Permessi repository (PR e merge)",
          ok: false,
          detail: `accesso al repository negato (status ${r.status}): verifica il token e che abbia accesso a questo repo`,
        };
      }
      return {
        name: "Permessi repository (PR e merge)",
        ok: false,
        detail: `risposta inattesa dalla REST API (status ${r.status})`,
      };
    }, "Permessi repository (PR e merge)");

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
    config: AccountConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    // GitHub ignora il workspace: /user/repos elenca già tutti i repo accessibili.
    const { token } = config.credentials.credentials;

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
          body: JSON.stringify({ active: true, events: ["pull_request", "push"], config }),
        });
        this.guardWebhookResponse(updateResponse);
        return { created: false, updated: true, id: String(existing.id), detail: "Webhook aggiornato" };
      }

      const createResponse = await fetchImpl(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "web", active: true, events: ["pull_request", "push"], config }),
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
    config: AccountConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<RepoSummary[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    // GitHub ignora il workspace: /user/repos elenca già tutti i repo accessibili.
    const headers = {
      Authorization: `Bearer ${config.credentials.credentials.token}`,
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

/**
 * Mappa `status`/`conclusion` di un check-run GitHub sul rollup a tre stati
 * condiviso. `status !== "completed"` (queued/in_progress) è sempre
 * `pending`: non c'è ancora un verdetto, a prescindere da `conclusion`
 * (assente finché il check non finisce). `neutral`/`skipped`/`stale` NON
 * bloccano: sono conclusioni "il check ha scelto di non esprimersi", non un
 * fallimento — solo `failure`/`timed_out`/`cancelled`/`action_required` lo sono.
 */
function githubCheckStatus(status: unknown, conclusion: unknown): CheckOutcomeStatus {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
    return "success";
  }
  return "failure";
}
