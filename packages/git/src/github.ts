import {
  basicAuthHeader,
  ensureListResponse,
  ensureCommitStatusResponse,
  ensureOkResponse,
  ensureOkResponseWithHint,
  fetchWithTimeout,
  getHeader,
  GitProviderError,
  isFullCommitSha,
  assertPageOnApiHost,
  parseNextLink,
  parseRepoUrl,
  PR_REVIEW_PERMISSION_HINT,
  readJsonResponse,
  rollupCheckStatus,
  verifyHmacSignature,
  MergeNotAllowedError,
  type AccountConfig,
  type AccountCredentials,
  type ChangesRequestedEvent,
  type CommitStatusInput,
  type CheckOutcomeStatus,
  type CredentialCheck,
  type FetchLike,
  type GitProvider,
  type GitProviderOptions,
  type PrActivityEvent,
  type PrComment,
  type PrReviewVerdict,
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

/** Tetto di pagine PER FONTE di commenti di una PR: 10 da 100 (~1000). Oltre
 * è un'anomalia, e un Link `next` che non termina non deve girare
 * all'infinito. Arrivati al tetto con ancora una pagina successiva si LANCIA,
 * non si tronca: una fotografia parziale verrebbe presa per completa e i
 * commenti persi resterebbero fuori per sempre. L'errore evita sia quello sia
 * il ciclo. */
const MAX_COMMENT_PAGES = 10;

/** Lunghezza massima della descrizione di uno status di commit su GitHub. */
const MAX_STATUS_DESCRIPTION = 140;

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
   * Nuovo commento sulla PR (su GitHub i commenti di conversazione delle PR
   * sono issue comment): sempre un POST, mai la modifica di uno esistente.
   */
  async createPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    await ensureOkResponse(response, "GitHub");
  }

  /**
   * Feedback scritto su una PR, da tre fonti: conversazione (issue comment),
   * righe (review comment, con `path`/`line` — `original_line` se la riga non
   * è più nel diff) e testo delle review inviate (le PENDING no, i testi vuoti
   * no: un "Approve" senza testo non è feedback). Ordinato per data; id con
   * prefisso per fonte (`issue-`, `review-comment-`, `review-`), perché GitHub
   * non garantisce che gli id delle tre non si sovrappongano. L'autore passa
   * da {@link githubAuthor} per tutte e tre, la stessa funzione del webhook
   * "Request changes": scarta ciò che non ha un id numerico sicuro (vedi
   * {@link PrComment}). Lancia GitProviderError sui non-2xx: la fotografia
   * del feedback non si prende a metà.
   */
  async listPrComments(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<PrComment[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
    };
    const base = `${API_BASE}/repos/${owner}/${repo}`;
    const comments: PrComment[] = [];

    for (const raw of await this.fetchCommentPages(fetchImpl, `${base}/issues/${prNumber}/comments?per_page=100`, headers)) {
      const c = raw as { id?: unknown; user?: unknown; body?: unknown; created_at?: unknown };
      const author = githubAuthor(c.user);
      if (author === null || !Number.isSafeInteger(c.id) || typeof c.created_at !== "string") continue;
      if (typeof c.body !== "string" || c.body.trim().length === 0) continue;
      comments.push({
        id: `issue-${String(c.id)}`,
        authorId: author.id,
        authorLogin: author.login,
        body: c.body,
        createdAt: c.created_at,
        path: null,
        line: null,
      });
    }

    for (const raw of await this.fetchCommentPages(fetchImpl, `${base}/pulls/${prNumber}/comments?per_page=100`, headers)) {
      const c = raw as {
        id?: unknown;
        user?: unknown;
        body?: unknown;
        created_at?: unknown;
        path?: unknown;
        line?: unknown;
        original_line?: unknown;
      };
      const author = githubAuthor(c.user);
      if (author === null || !Number.isSafeInteger(c.id) || typeof c.created_at !== "string") continue;
      if (typeof c.body !== "string" || c.body.trim().length === 0) continue;
      const path = typeof c.path === "string" ? c.path : null;
      const line =
        path === null
          ? null
          : Number.isSafeInteger(c.line)
            ? (c.line as number)
            : Number.isSafeInteger(c.original_line)
              ? (c.original_line as number)
              : null;
      comments.push({
        id: `review-comment-${String(c.id)}`,
        authorId: author.id,
        authorLogin: author.login,
        body: c.body,
        createdAt: c.created_at,
        path,
        line,
      });
    }

    for (const raw of await this.fetchCommentPages(fetchImpl, `${base}/pulls/${prNumber}/reviews?per_page=100`, headers)) {
      const r = raw as { id?: unknown; user?: unknown; body?: unknown; state?: unknown; submitted_at?: unknown };
      const author = githubAuthor(r.user);
      if (author === null || !Number.isSafeInteger(r.id) || typeof r.submitted_at !== "string") continue;
      if (r.state === "PENDING") continue;
      if (typeof r.body !== "string" || r.body.trim().length === 0) continue;
      comments.push({
        id: `review-${String(r.id)}`,
        authorId: author.id,
        authorLogin: author.login,
        body: r.body,
        createdAt: r.submitted_at,
        path: null,
        line: null,
      });
    }

    return comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  /**
   * Status di commit di Stubwise (design §8): `context` = key. GitHub non
   * sovrascrive: ACCODA uno status nuovo a ogni chiamata, e la vista combinata
   * e la protezione del branch usano l'ultimo per `context` (tetto di 1000
   * status per sha e context). `refname` non serve (GitHub associa per sha).
   * Descrizione troncata a 140 caratteri. Sha completo obbligatorio. Lancia
   * GitProviderError (best-effort a monte); su 401/403 il messaggio dice quale
   * permesso manca al token.
   */
  async setCommitStatus(
    p: ProjectGitConfig,
    sha: string,
    status: CommitStatusInput,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    if (!isFullCommitSha(sha)) {
      throw new GitProviderError(
        `GitHub: lo status di commit richiede lo sha completo (40 caratteri), ricevuto "${sha}"`,
        0,
        ""
      );
    }
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const description =
      status.description.length > MAX_STATUS_DESCRIPTION
        ? `${status.description.slice(0, MAX_STATUS_DESCRIPTION - 1)}…`
        : status.description;
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/statuses/${sha}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: status.state,
        context: status.key,
        description,
        ...(status.url !== undefined ? { target_url: status.url } : {}),
      }),
    });
    await ensureCommitStatusResponse(response, "GitHub");
  }

  /**
   * Verdetto dell'account revisore come review GitHub (design §8): una sola
   * richiesta, `POST /pulls/{n}/reviews`, testo incluso — quindi chi chiama
   * NON pubblica anche un `createPrComment`, o il testo uscirebbe doppio.
   * `body` è obbligatorio per REQUEST_CHANGES (GitHub lo esige): un testo
   * vuoto o di soli spazi è un errore locale, senza chiamare GitHub, perché
   * il 422 che ne tornerebbe sembrerebbe un altro problema. Per APPROVE il
   * testo vuoto si omette. GitHub rifiuta con 422 sia APPROVE sia
   * REQUEST_CHANGES dall'autore della PR: l'account revisore DEVE essere un
   * account diverso da quello che apre le PR. Il messaggio del 422 nomina
   * l'autore solo se la risposta lo dice ("own pull request"); altrimenti
   * riporta un estratto della risposta (che non contiene l'Authorization) e
   * indica l'autore come causa possibile. Su 401/403 il messaggio nomina il
   * permesso mancante ({@link PR_REVIEW_PERMISSION_HINT}), come il gemello
   * Bitbucket.
   */
  async submitPrReview(
    p: ProjectGitConfig,
    prNumber: number,
    verdict: PrReviewVerdict,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    const hasBody = body.trim().length > 0;
    if (verdict === "request_changes" && !hasBody) {
      throw new GitProviderError("GitHub: REQUEST_CHANGES richiede un testo (il corpo della review è vuoto)", 0, "");
    }
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event: verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        ...(hasBody ? { body } : {}),
      }),
    });
    if (response.status === 422) {
      const text = (await response.text().catch(() => "")).slice(0, 500);
      const message = /own pull request/i.test(text)
        ? "GitHub: review rifiutata (422) — GitHub non permette all'autore della PR di approvarla o di chiedere modifiche: verifica che l'account revisore sia diverso da quello che apre le PR"
        : `GitHub: review rifiutata (422): ${text.slice(0, 200)} — una causa possibile è l'account revisore che coincide con l'autore della PR`;
      throw new GitProviderError(message, 422, text);
    }
    await ensureOkResponseWithHint(response, "GitHub", PR_REVIEW_PERMISSION_HINT);
  }

  /**
   * Identità stabile dell'account sulla piattaforma (design §4/§5): l'`id`
   * numerico di `GET /user`, come stringa — MAI il login, che cambia. Lo
   * ricava {@link githubAuthor}, la stessa funzione che dà `actorId` al
   * webhook "Request changes" e `authorId` ai commenti: il confronto del
   * design §5 è un'uguaglianza di stringhe, e la forma sta in un posto solo.
   * Accetta qualunque oggetto con `credentials` (ProjectGitConfig o
   * AccountCredentials). Lancia GitProviderError: sul 401 dice che le
   * credenziali non valgono; sul 403 che il token non rappresenta un utente —
   * l'installation token di una GitHub App riceve 403 su `/user`, e l'account
   * (principale o revisore) deve essere un utente con un personal access
   * token — salvo che il 403 sia il rate limit (`x-ratelimit-remaining: 0` o
   * "rate limit" nel corpo), che ha un messaggio suo. Senza un id intero
   * sicuro lancia invece di inventare un'identità. Mai il token in un
   * messaggio.
   */
  async getAuthenticatedUserId(
    p: Pick<ProjectGitConfig, "credentials">,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<string> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const response = await fetchImpl(`${API_BASE}/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status === 401 || response.status === 403) {
      const text = (await response.text().catch(() => "")).slice(0, 500);
      // Un 403 di GitHub è anche il rate limit primario/secondario: lì il
      // token va bene, e dire "non una GitHub App" manderebbe a cercare il
      // guasto nel posto sbagliato.
      const rateLimited =
        response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
      const message =
        response.status === 401
          ? "GitHub: credenziali non valide leggendo l'identità dell'account (401) — verifica il token"
          : rateLimited
            ? "GitHub: limite di richieste raggiunto leggendo l'identità dell'account (403, rate limit) — riprova più tardi"
            : "GitHub: il token non può leggere la propria identità (403) — l'account (principale o revisore) deve essere un utente GitHub con un personal access token, non una GitHub App: l'installation token di un'App non può leggere /user";
      throw new GitProviderError(message, response.status, text);
    }
    await ensureOkResponse(response, "GitHub");
    const data = await readJsonResponse(response, "GitHub");
    const account = githubAuthor(data);
    if (account === null) {
      throw new GitProviderError(
        "GitHub: la risposta di /user non contiene un id numerico: identità dell'account non determinabile",
        response.status,
        ""
      );
    }
    return account.id;
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

  /**
   * "Request changes" su una PR (ciclo di correzione, design §9): evento
   * `pull_request_review`, action `submitted`, `review.state`
   * `changes_requested` — minuscolo nel webhook, maiuscolo nella REST: si
   * accettano entrambi. `review.body` può essere null. Ogni altro stato
   * (approved, commented) e ogni altra action (edited, dismissed) → null.
   * Mai lancia.
   *
   * `review.user` è l'autore della review; in `submitted` `sender` coincide,
   * quindi non va confrontato. L'asimmetria con Bitbucket, dove actor e
   * changes_request.user sono due campi che possono discordare, è voluta.
   */
  parseChangesRequestedEvent(
    headers: Record<string, string>,
    body: unknown
  ): ChangesRequestedEvent | null {
    if (getHeader(headers, "x-github-event") !== "pull_request_review") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { action?: unknown; review?: unknown; pull_request?: unknown };
    if (payload.action !== "submitted") return null;
    if (typeof payload.review !== "object" || payload.review === null) return null;
    if (typeof payload.pull_request !== "object" || payload.pull_request === null) return null;
    const review = payload.review as {
      state?: unknown;
      body?: unknown;
      user?: { id?: unknown; login?: unknown } | null;
    };
    if (typeof review.state !== "string" || review.state.toLowerCase() !== "changes_requested") {
      return null;
    }
    const pr = payload.pull_request as { number?: unknown; head?: { ref?: unknown } };
    const actor = githubAuthor(review.user);
    if (
      typeof pr.number !== "number" ||
      !Number.isSafeInteger(pr.number) ||
      typeof pr.head?.ref !== "string" ||
      actor === null
    ) {
      return null;
    }
    const reviewBody =
      typeof review.body === "string" && review.body.trim().length > 0 ? review.body : null;
    return {
      prNumber: pr.number,
      sourceBranch: pr.head.ref,
      actorId: actor.id,
      actorLogin: actor.login,
      reviewBody,
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
      // Il `next` lo sceglie la risposta: mai seguirlo fuori dall'API col token.
      assertPageOnApiHost(url, API_BASE, "GitHub");
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
      // Il `next` lo sceglie la risposta: mai seguirlo fuori dall'API col token.
      assertPageOnApiHost(url, API_BASE, "GitHub");
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
   * GET paginato con l'header Link (`parseNextLink`), fino a
   * {@link MAX_COMMENT_PAGES}. O tutte le pagine o un GitProviderError, mai
   * una fotografia a metà: lancia su un corpo che non è un array (risposta
   * inattesa), su una pagina successiva oltre il tetto, e su un `next` che non
   * sta sull'host dell'API GitHub — quest'ultimo PRIMA di seguirlo, perché la
   * richiesta porterebbe il token altrove.
   */
  private async fetchCommentPages(
    fetchImpl: FetchLike,
    firstUrl: string,
    headers: Record<string, string>
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_COMMENT_PAGES && url; page++) {
      assertPageOnApiHost(url, API_BASE, "GitHub");
      const response = await fetchImpl(url, { method: "GET", headers });
      await ensureOkResponse(response, "GitHub");
      const link = response.headers.get("link");
      const data = await readJsonResponse(response, "GitHub");
      if (!Array.isArray(data)) {
        throw new GitProviderError(
          "GitHub: risposta inattesa leggendo i commenti della PR: non prendo una fotografia parziale",
          0,
          ""
        );
      }
      items.push(...(data as unknown[]));
      url = parseNextLink(link);
    }
    if (url) {
      throw new GitProviderError(
        `GitHub: oltre ${MAX_COMMENT_PAGES} pagine di commenti sulla PR: non prendo una fotografia parziale`,
        0,
        ""
      );
    }
    return items;
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

/**
 * Identità di un utente GitHub in un commento, una review o un webhook: id
 * numerico come stringa (stabile, sopravvive a un cambio di login — è ciò che
 * si confronta con gli account di Stubwise) e login. Null se `user` manca o è
 * null (account cancellato, "ghost"), se l'id non è un intero sicuro o se il
 * login manca: senza un id affidabile non lo si può escludere dagli account
 * di Stubwise. UNA funzione per commenti e webhook, così le due identità non
 * possono divergere.
 */
function githubAuthor(raw: unknown): { id: string; login: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const user = raw as { id?: unknown; login?: unknown };
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
  if (typeof user.login !== "string") return null;
  return { id: String(user.id), login: user.login };
}
