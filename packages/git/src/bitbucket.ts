import {
  basicAuthHeader,
  ensureListResponse,
  ensureCommitStatusResponse,
  ensureOkResponse,
  ensureOkResponseWithHint,
  fetchWithTimeout,
  getHeader,
  GitProviderError,
  assertPageOnApiHost,
  isFullCommitSha,
  parseRepoUrl,
  PR_REVIEW_PERMISSION_HINT,
  withPermissionHint,
  readJsonResponse,
  rollupCheckStatus,
  verifyHmacSignature,
  MergeNotAllowedError,
  type AccountConfig,
  type AccountCredentials,
  type ChangesRequestedEvent,
  type CheckOutcomeStatus,
  type CommitStatusInput,
  type CommitStatusState,
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
  type SubmitPrReviewOutcome,
  type WebhookEvent,
  type WebhookResult,
} from "./provider.js";

const API_BASE = "https://api.bitbucket.org/2.0";

/** Tetto di pagine di repository PER WORKSPACE: ~3 pagine da 100 (~300 repo),
 * seguendo il cursore `next` di Bitbucket. Vedi MAX_REPO_PAGES di github.ts. */
const MAX_REPO_PAGES = 3;

/** Tetto TOTALE di repository restituiti (~300): mantiene il picker reattivo e
 * limita il fan-out delle chiamate. */
const MAX_TOTAL_REPOS = 300;

/** Tetto di branch elencati: ~2 pagine da 100 (~200 branch). */
const MAX_BRANCH_PAGES = 2;

/** Tetto di pagine di commenti di una PR: 10 da 100 (~1000 commenti). Oltre
 * è un'anomalia, e un `next` che non termina non deve girare all'infinito.
 * Arrivati al tetto con ancora una pagina successiva si LANCIA, non si tronca:
 * una fotografia parziale verrebbe presa per completa e i commenti persi
 * resterebbero fuori per sempre. L'errore evita sia quello sia il ciclo. */
const MAX_COMMENT_PAGES = 10;

/** Tetto di pagine della lista webhook di un repository: 5 da 100. Oltre è
 * un'anomalia (un repository ha pochi hook), e un `next` che non termina non
 * deve girare all'infinito. Arrivati al tetto con ancora una pagina
 * successiva si LANCIA invece di concludere «non c'è»: ensureWebhook
 * creerebbe un duplicato di un hook che sta solo in una pagina non letta.
 * Meglio fallire che duplicare. */
const MAX_HOOK_PAGES = 5;

/** Nome leggibile dello status di Stubwise nella UI di Bitbucket. */
const COMMIT_STATUS_NAME = "Stubwise review";

const BITBUCKET_STATUS_STATE: Record<CommitStatusState, "INPROGRESS" | "SUCCESSFUL" | "FAILED"> = {
  pending: "INPROGRESS",
  success: "SUCCESSFUL",
  failure: "FAILED",
};

interface BitbucketCommentPayload {
  id?: unknown;
  created_on?: unknown;
  deleted?: unknown;
  pending?: unknown;
  content?: { raw?: unknown };
  user?: unknown;
  inline?: { path?: unknown; to?: unknown; from?: unknown };
}

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
    const response = await this.fetchImpl(`${API_BASE}/repositories/${owner}/${repo}/pullrequests`, {
      method: "POST",
      headers: {
        Authorization: this.projectRestAuthHeader(p),
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

  /** Stato attuale della PR via REST: OPEN → 'open'; MERGED/DECLINED/SUPERSEDED → 'closed'. */
  async getPullRequestState(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<"open" | "closed"> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const auth = this.projectRestAuthHeader(p);
    const response = await fetchImpl(
      `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}`,
      { method: "GET", headers: { Authorization: auth } }
    );
    await ensureOkResponse(response, "Bitbucket");
    const data = (await readJsonResponse(response, "Bitbucket")) as { state?: unknown };
    return data.state === "OPEN" ? "open" : "closed";
  }

  /**
   * Build status della PR via REST: una pagina da 100 (come il commento
   * sticky) — l'endpoint elenca i report su TUTTI i commit della PR, non
   * serve risolvere lo sha per LEGGERLI. Lo si risolve comunque con una
   * richiesta in più (fase 8, review fix Task 4), lo stesso oggetto PR di
   * `getPullRequestState`: `headSha` lo riusa il chiamante per "questa PR è
   * già su un ambiente?" senza una chiamata a parte, e senza fidarsi
   * dell'artefatto di un'altra automazione (`pr_reviews.headSha`, assente se
   * la review non è mai girata su questa PR). Mai lancia: un errore prima di
   * aver risolto la PR ricade su `{ status: "unknown", checks: [] }` (fase 8,
   * review fix Task 2) — un corpo malformato sulle statuses, dopo aver
   * risolto la PR, ricade sullo stesso `unknown` ma con `headSha` già
   * valorizzato.
   */
  async getPullRequestChecks(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<PullRequestChecks> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const auth = this.projectRestAuthHeader(p);
    let headSha: string | undefined;
    let headRef: string | undefined;
    try {
      const prResponse = await fetchImpl(
        `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}`,
        { method: "GET", headers: { Authorization: auth } }
      );
      await ensureOkResponse(prResponse, "Bitbucket");
      const pr = (await readJsonResponse(prResponse, "Bitbucket")) as {
        source?: { commit?: { hash?: unknown }; branch?: { name?: unknown } };
      };
      const resolvedHeadSha = pr.source?.commit?.hash;
      if (typeof resolvedHeadSha === "string") headSha = resolvedHeadSha;
      if (typeof pr.source?.branch?.name === "string") headRef = pr.source.branch.name;
      const extra = {
        ...(headSha !== undefined ? { headSha } : {}),
        ...(headRef !== undefined ? { headRef } : {}),
      };

      const response = await fetchImpl(
        `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}/statuses?pagelen=100`,
        { method: "GET", headers: { Authorization: auth } }
      );
      await ensureOkResponse(response, "Bitbucket");
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        values?: { name?: unknown; key?: unknown; state?: unknown }[];
      };
      const values = Array.isArray(data.values) ? data.values : [];
      if (values.length === 0) return { status: "no_checks", checks: [], ...extra };

      const checks = values.map((v) => ({
        name: typeof v.name === "string" ? v.name : typeof v.key === "string" ? v.key : "check",
        status: bitbucketCheckStatus(v.state),
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
   * Mergia la PR (fase 8, Task 8): merge commit (nessuna riscrittura di
   * storia). Bitbucket non ha uno status dedicato "non mergiabile" come il
   * 405 di GitHub: 400 e 409 coprono entrambi conflitti/regole non
   * soddisfatte a seconda della versione dell'API, quindi li mappiamo
   * entrambi su `not_mergeable`.
   */
  async mergePullRequest(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<{ merged: true; sha: string }> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(
      `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}/merge`,
      {
        method: "POST",
        headers: {
          Authorization: this.projectRestAuthHeader(p),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ merge_strategy: "merge_commit" }),
      }
    );

    if (response.ok) {
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        merge_commit?: { hash?: unknown };
      };
      const sha = data.merge_commit?.hash;
      if (typeof sha === "string") return { merged: true, sha };
      throw new MergeNotAllowedError(
        "unknown",
        "Bitbucket merge response is missing merge_commit.hash",
        response.status,
        JSON.stringify(data).slice(0, 500)
      );
    }

    const bodyText = await response.text().catch(() => "");
    if (response.status === 400 || response.status === 409) {
      throw new MergeNotAllowedError(
        "not_mergeable",
        "Bitbucket: la PR non è mergiabile (conflitti o regole del branch non soddisfatte)",
        response.status,
        bodyText.slice(0, 500)
      );
    }
    if (response.status === 403) {
      throw new MergeNotAllowedError(
        "forbidden",
        "Bitbucket: il token non ha il permesso di mergiare questa PR",
        403,
        bodyText.slice(0, 500)
      );
    }
    if (response.status === 404) {
      throw new MergeNotAllowedError(
        "forbidden",
        "Bitbucket: PR non trovata o non accessibile con queste credenziali",
        404,
        bodyText.slice(0, 500)
      );
    }
    throw new MergeNotAllowedError(
      "unknown",
      `Bitbucket merge fallito con status ${response.status}`,
      response.status,
      bodyText.slice(0, 500)
    );
  }

  /** Nuovo commento sulla PR: sempre un POST, mai la modifica di uno esistente. */
  async createPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const auth = this.projectRestAuthHeader(p);
    const response = await fetchImpl(
      `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}/comments`,
      {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      }
    );
    await ensureOkResponse(response, "Bitbucket");
  }

  /**
   * Commenti della PR (generali, sulle righe e risposte), dal più vecchio al
   * più nuovo come li ordina Bitbucket, seguendo `next` fino al tetto
   * {@link MAX_COMMENT_PAGES}. Mai i cancellati (`deleted`), le bozze
   * (`pending`), i vuoti, né quelli senza `user.uuid` (vedi {@link PrComment}).
   * Lancia GitProviderError sui non-2xx: la fotografia del feedback non si
   * prende a metà.
   */
  async listPrComments(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<PrComment[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const auth = this.projectRestAuthHeader(p);
    const comments: PrComment[] = [];
    let url: string | null =
      `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}/comments?pagelen=100`;
    for (let page = 0; page < MAX_COMMENT_PAGES && url; page++) {
      // Il `next` lo sceglie la risposta: mai seguirlo fuori dall'API col token.
      assertPageOnApiHost(url, API_BASE, "Bitbucket");
      const response = await fetchImpl(url, { method: "GET", headers: { Authorization: auth } });
      await ensureOkResponse(response, "Bitbucket");
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        values?: unknown;
        next?: unknown;
      } | null;
      // Una pagina senza `values` non è "nessun commento": è una risposta che
      // non capiamo, e contarla come vuota darebbe una fotografia a metà.
      if (typeof data !== "object" || data === null || !Array.isArray(data.values)) {
        throw new GitProviderError(
          "Bitbucket: risposta inattesa leggendo i commenti della PR: non prendo una fotografia parziale",
          0,
          ""
        );
      }
      for (const raw of data.values as BitbucketCommentPayload[]) {
        const comment = bitbucketComment(raw);
        if (comment !== null) comments.push(comment);
      }
      url = typeof data.next === "string" ? data.next : null;
    }
    if (url) {
      throw new GitProviderError(
        `Bitbucket: oltre ${MAX_COMMENT_PAGES} pagine di commenti sulla PR: non prendo una fotografia parziale`,
        0,
        ""
      );
    }
    return comments;
  }

  /**
   * Status di commit di Stubwise (design §8). Stessa `key` sullo stesso commit
   * = sovrascrive (documentato). `refname` associa lo status alla PR (la doc
   * lo dice necessario); `url` si manda sempre — senza quello del chiamante,
   * la pagina della repository. Lo sha dev'essere completo: un abbreviato è
   * rifiutato qui, prima della richiesta. Lancia GitProviderError: chi chiama
   * lo tratta come best-effort (design §8).
   */
  async setCommitStatus(
    p: ProjectGitConfig,
    sha: string,
    status: CommitStatusInput,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    if (!isFullCommitSha(sha)) {
      throw new GitProviderError(
        `Bitbucket: lo status di commit richiede lo sha completo (40 caratteri), ricevuto "${sha}"`,
        0,
        ""
      );
    }
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { host, owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(
      `${API_BASE}/repositories/${owner}/${repo}/commit/${sha}/statuses/build`,
      {
        method: "POST",
        headers: { Authorization: this.projectRestAuthHeader(p), "Content-Type": "application/json" },
        body: JSON.stringify({
          key: status.key,
          state: BITBUCKET_STATUS_STATE[status.state],
          name: COMMIT_STATUS_NAME,
          description: status.description,
          url: status.url ?? `https://${host}/${owner}/${repo}`,
          ...(status.refname !== undefined ? { refname: status.refname } : {}),
        }),
      }
    );
    await ensureCommitStatusResponse(response, "Bitbucket");
  }

  /**
   * Verdetto dell'account revisore come stato vero della PR (design §8).
   * Bitbucket non ha un testo per il verdetto: stato e commento sono due
   * chiamate. Ordine: (1) DELETE dell'opposto, best-effort — un partecipante
   * ha UNO stato (approved | changes_requested), quindi si ritira l'altro; la
   * risposta non si guarda (il caso "niente da ritirare" non è documentato)
   * e anche un errore di rete si ignora; (2) POST del verdetto; (3) il
   * commento, se il corpo non è vuoto. Il verdetto va PRIMA del testo perché
   * chi chiama (C10), se questo metodo fallisce, ripiega su `createPrComment`
   * con l'account principale: se il verdetto fallisce non è uscito niente, se
   * fallisce il commento il ripiego pubblica il testo una volta sola — con
   * l'ordine opposto un verdetto fallito dopo il commento lo farebbe uscire
   * due volte. L'autore della PR può approvarla ma la sua approvazione non
   * conta per i merge check: per questo serve un account revisore distinto.
   * Su 401/403 (stato o commento) il messaggio nomina il permesso mancante
   * ({@link PR_REVIEW_PERMISSION_HINT}); gli altri errori passano invariati.
   * Limite accettato: se il DELETE dell'opposto riesce e poi il POST del
   * verdetto fallisce, la PR resta SENZA stato del revisore (quello
   * precedente è già stato ritirato). Il ripiego di C10 pubblica il testo ma
   * non ripristina il verdetto di prima. La verifica dal vivo del POST
   * ripetuto è nel task B14 del piano: nell'attesa, un 409 sul POST del
   * verdetto si tratta come «già in quello stato» (esito
   * `"already_in_state"`, il commento parte comunque) — scelta difensiva da
   * confermare con B14 §7a.
   */
  async submitPrReview(
    p: ProjectGitConfig,
    prNumber: number,
    verdict: PrReviewVerdict,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<SubmitPrReviewOutcome> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const auth = this.projectRestAuthHeader(p);
    const prBase = `${API_BASE}/repositories/${owner}/${repo}/pullrequests/${prNumber}`;
    // `as const`: senza, l'array è string[] e con noUncheckedIndexedAccess la
    // destrutturazione darebbe string | undefined.
    const [withdraw, submit] =
      verdict === "approve"
        ? (["request-changes", "approve"] as const)
        : (["approve", "request-changes"] as const);
    try {
      const withdrawn = await fetchImpl(`${prBase}/${withdraw}`, {
        method: "DELETE",
        headers: { Authorization: auth },
      });
      await withdrawn.body?.cancel();
    } catch {
      // best-effort: il POST qui sotto decide.
    }
    const response = await fetchImpl(`${prBase}/${submit}`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    // 409 sul verdetto = l'account è GIÀ in quello stato (es. un secondo
    // approve): SCELTA DIFENSIVA da confermare con B14 §7a — si tratta come
    // successo e il commento parte comunque, così il chiamante non ripiega
    // sul commento dell'account principale per uno stato già giusto. Ogni
    // altro non-2xx resta un errore.
    let outcome: SubmitPrReviewOutcome = "submitted";
    if (response.status === 409) {
      await response.body?.cancel();
      outcome = "already_in_state";
    } else {
      await ensureOkResponseWithHint(response, "Bitbucket", PR_REVIEW_PERMISSION_HINT);
    }
    if (body.trim().length > 0) {
      try {
        await this.createPrComment(p, prNumber, body, { fetchImpl });
      } catch (error) {
        throw withPermissionHint(error, PR_REVIEW_PERMISSION_HINT);
      }
    }
    return outcome;
  }

  /**
   * Identità stabile dell'account sulla piattaforma (design §4/§5): lo uuid di
   * `GET /2.0/user`, GREZZO — graffe comprese e maiuscole come arrivano. Lo
   * ricava {@link bitbucketAccount}, la stessa funzione che dà `actorId` al
   * webhook "Request changes" e `authorId` ai commenti: il confronto del
   * design §5 è un'uguaglianza di stringhe, e la forma sta in un posto solo.
   * Accetta qualunque oggetto con `credentials` (ProjectGitConfig o
   * AccountCredentials); identità REST come gli altri metodi (email
   * Atlassian, poi username). Lancia GitProviderError: sul 401 dice che le
   * credenziali non valgono, sul 403 lo scope mancante (`read:user:bitbucket`
   * dell'API token); senza uuid lancia invece di
   * restituire un'identità vuota. Mai il token in un messaggio.
   */
  async getAuthenticatedUserId(
    p: Pick<ProjectGitConfig, "credentials">,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<string> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const response = await fetchImpl(`${API_BASE}/user`, {
      method: "GET",
      headers: { Authorization: this.projectRestAuthHeader(p) },
    });
    if (response.status === 401 || response.status === 403) {
      const text = (await response.text().catch(() => "")).slice(0, 500);
      throw new GitProviderError(
        response.status === 401
          ? "Bitbucket: credenziali non valide leggendo l'identità dell'account (401) — verifica email/username e token"
          : "Bitbucket: il token non può leggere la propria identità (403) — all'API token serve lo scope read:user:bitbucket",
        response.status,
        text
      );
    }
    await ensureOkResponse(response, "Bitbucket");
    const data = await readJsonResponse(response, "Bitbucket");
    const account = bitbucketAccount(data);
    if (account === null) {
      throw new GitProviderError(
        "Bitbucket: la risposta di /user non contiene uno uuid: identità dell'account non determinabile",
        response.status,
        ""
      );
    }
    return account.id;
  }

  parseWebhook(headers: Record<string, string>, body: unknown): WebhookEvent | null {
    const eventKey = getHeader(headers, "x-event-key");
    const kind =
      eventKey === "pullrequest:fulfilled"
        ? "merged"
        : eventKey === "pullrequest:rejected"
          ? "closed_unmerged"
          : null;
    if (kind === null) return null;
    if (typeof body !== "object" || body === null) return null;
    const pullrequest = (body as { pullrequest?: unknown }).pullrequest;
    if (typeof pullrequest !== "object" || pullrequest === null) return null;
    const pr = pullrequest as {
      id?: unknown;
      source?: { branch?: { name?: unknown } };
      links?: { html?: { href?: unknown } };
    };
    const branch = pr.source?.branch?.name;
    const prUrl = pr.links?.html?.href;
    if (typeof branch !== "string" || typeof prUrl !== "string") return null;
    // Id mancante o malformato: l'evento di chiusura resta valido (serve alla
    // chiusura del ticket via branch), solo il cleanup review lo salta.
    const prNumber = typeof pr.id === "number" ? pr.id : null;
    return { kind, provider: "bitbucket", branch, prUrl, prNumber };
  }

  /**
   * Eventi PR created/updated per l'automazione PR Review: pullrequest:created
   * diventa `opened`, pullrequest:updated diventa `updated` (Bitbucket lo emette
   * anche su edit di titolo/descrizione: il debounce a valle assorbe il rumore).
   * L'hash del commit sorgente è abbreviato (~12 char): va bene, git lo risolve
   * nel mirror. Ogni body malformato restituisce null, senza mai lanciare.
   */
  parsePrEvent(headers: Record<string, string>, body: unknown): PrActivityEvent | null {
    const eventKey = getHeader(headers, "x-event-key");
    const kind =
      eventKey === "pullrequest:created"
        ? "opened"
        : eventKey === "pullrequest:updated"
          ? "updated"
          : null;
    if (kind === null) return null;
    if (typeof body !== "object" || body === null) return null;
    const pullrequest = (body as { pullrequest?: unknown }).pullrequest;
    if (typeof pullrequest !== "object" || pullrequest === null) return null;
    const pr = pullrequest as {
      id?: unknown;
      title?: unknown;
      description?: unknown;
      source?: { branch?: { name?: unknown }; commit?: { hash?: unknown } };
      destination?: { branch?: { name?: unknown } };
      links?: { html?: { href?: unknown } };
    };
    const sourceBranch = pr.source?.branch?.name;
    const headSha = pr.source?.commit?.hash;
    const targetBranch = pr.destination?.branch?.name;
    const prUrl = pr.links?.html?.href;
    if (
      typeof pr.id !== "number" ||
      typeof pr.title !== "string" ||
      typeof sourceBranch !== "string" ||
      typeof headSha !== "string" ||
      typeof targetBranch !== "string" ||
      typeof prUrl !== "string"
    ) {
      return null;
    }
    return {
      kind,
      provider: "bitbucket",
      prNumber: pr.id,
      title: pr.title,
      description: typeof pr.description === "string" ? pr.description : "",
      sourceBranch,
      targetBranch,
      headSha,
      prUrl,
    };
  }

  /**
   * "Request changes" su una PR (ciclo di correzione, design §9). Il payload
   * documentato è `{ actor, pullrequest, repository, changes_request: { date,
   * user } }`: nessun testo, quindi `reviewBody` è sempre null. L'autore è
   * `changes_request.user`, con `actor` come ripiego; se entrambi hanno un
   * uuid e non coincidono l'evento è scartato — non si può escludere che sia
   * di un account di Stubwise (design §5, fail-closed). Mai lancia.
   */
  parseChangesRequestedEvent(
    headers: Record<string, string>,
    body: unknown
  ): ChangesRequestedEvent | null {
    if (getHeader(headers, "x-event-key") !== "pullrequest:changes_request_created") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as {
      actor?: unknown;
      pullrequest?: unknown;
      changes_request?: { user?: unknown } | null;
    };
    if (typeof payload.pullrequest !== "object" || payload.pullrequest === null) return null;
    const pr = payload.pullrequest as { id?: unknown; source?: { branch?: { name?: unknown } } };
    const sourceBranch = pr.source?.branch?.name;
    if (
      typeof pr.id !== "number" ||
      !Number.isSafeInteger(pr.id) ||
      typeof sourceBranch !== "string"
    ) {
      return null;
    }

    const requester = bitbucketAccount(payload.changes_request?.user);
    const actor = bitbucketAccount(payload.actor);
    if (requester !== null && actor !== null && requester.id !== actor.id) return null;
    const who = requester ?? actor;
    if (who === null) return null;
    return {
      prNumber: pr.id,
      sourceBranch,
      actorId: who.id,
      actorLogin: who.login,
      reviewBody: null,
      // Bitbucket non dice che rapporto ha l'autore col repository.
      authorAssociation: null,
    };
  }

  parsePushEvent(headers: Record<string, string>, body: unknown): PushWebhookEvent | null {
    if (getHeader(headers, "x-event-key") !== "repo:push") return null;
    if (typeof body !== "object" || body === null) return null;
    const changes = (body as { push?: { changes?: unknown } }).push?.changes;
    if (!Array.isArray(changes)) return null;
    // Solo i change che riguardano un branch (new.type === "branch"): i tag e i
    // delete (new === null) non interessano.
    for (const raw of changes) {
      if (typeof raw !== "object" || raw === null) continue;
      const change = raw as {
        old?: { target?: { hash?: unknown } };
        new?: { type?: unknown; name?: unknown; target?: { hash?: unknown } };
        commits?: unknown;
      };
      const next = change.new;
      if (!next || next.type !== "branch") continue;
      if (typeof next.name !== "string" || typeof next.target?.hash !== "string") continue;
      const beforeSha =
        typeof change.old?.target?.hash === "string" ? change.old.target.hash : "0".repeat(40);
      const commits = Array.isArray(change.commits)
        ? change.commits.flatMap((c) => {
            if (typeof c !== "object" || c === null) return [];
            const commit = c as { hash?: unknown; message?: unknown };
            if (typeof commit.hash !== "string" || typeof commit.message !== "string") return [];
            return [{ sha: commit.hash, message: commit.message }];
          })
        : [];
      return { branch: next.name, beforeSha, afterSha: next.target.hash, commits };
    }
    return null;
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

    // Check 4 — permesso di MERGE (fase 8, Task 8). A differenza di GitHub,
    // dove push discende dallo stesso bit usato per PR/merge, su Bitbucket la
    // lettura della lista PR (Check 2) NON implica scrittura: serve
    // interrogare esplicitamente il permesso dell'utente sul repository.
    // "write" o "admin" bastano a mergiare; "read" no — senza questo check
    // lo si scopriva solo al primo tentativo di merge (design fase 8 §4).
    const mergeCheck: CredentialCheck = !restUser
      ? {
          name: "Permesso di merge",
          ok: false,
          detail: "email Atlassian (o username legacy) mancante: serve come identità per la REST API",
        }
      : await this.probe("Permesso di merge", async () => {
          const query = encodeURIComponent(`repository.full_name="${owner}/${repo}"`);
          const r = await fetchWithTimeout(
            fetchImpl,
            `${API_BASE}/user/permissions/repositories?q=${query}`,
            { headers: { Authorization: basicAuthHeader(restUser, token) } }
          );
          if (r.status === 200) {
            const body = (await r.json().catch(() => null)) as {
              values?: { permission?: unknown }[];
            } | null;
            const permission = body?.values?.[0]?.permission;
            if (permission === "write" || permission === "admin") {
              return { name: "Permesso di merge", ok: true, detail: `permesso "${permission}" sul repository` };
            }
            return {
              name: "Permesso di merge",
              ok: false,
              detail:
                permission === "read"
                  ? "il token ha solo accesso in lettura: mergiare richiede write o admin"
                  : "nessun permesso trovato sul repository per questo token",
            };
          }
          if (r.status === 401) {
            return { name: "Permesso di merge", ok: false, detail: "autenticazione fallita (401)" };
          }
          return {
            name: "Permesso di merge",
            ok: false,
            detail: `risposta inattesa dall'endpoint dei permessi (status ${r.status})`,
          };
        });

    return [gitCheck, restCheck, webhookCheck, mergeCheck];
  }

  async validateAccount(
    config: AccountConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<CredentialCheck[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { username, email, token } = config.credentials.credentials;
    const workspace = config.workspace;

    // Identità REST = email Atlassian (gli API token autenticano su
    // api.bitbucket.org come email, non come username); fallback su username
    // per le app password legacy.
    const restUser = email ?? username;
    const CHECK = "Autenticazione e accesso workspace";
    if (!restUser) {
      return [
        {
          name: CHECK,
          ok: false,
          detail: "email Atlassian (o username legacy) mancante",
        },
      ];
    }

    // CHANGE-2770: Bitbucket Cloud ha dismesso TUTTI gli endpoint account/globali
    // per gli API token (GET /2.0/workspaces, /2.0/repositories?role=member,
    // /2.0/user/permissions/* → 410 Gone). Funzionano solo quelli scoped al
    // workspace, quindi il workspace è obbligatorio: senza, non possiamo
    // enumerarli e lo segnaliamo come check fallito.
    if (!workspace) {
      return [
        {
          name: CHECK,
          ok: false,
          detail:
            "workspace Bitbucket mancante (richiesto per gli API token: indica lo slug del workspace, es. mio-workspace)",
        },
      ];
    }

    const check = await this.probe(CHECK, async () => {
      const r = await fetchWithTimeout(
        fetchImpl,
        `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=1`,
        { headers: { Authorization: basicAuthHeader(restUser, token) } }
      );
      if (r.status === 200) {
        return {
          name: CHECK,
          ok: true,
          detail: `token valido, accesso al workspace «${workspace}» ok`,
        };
      }
      if (r.status === 401) {
        return {
          name: CHECK,
          ok: false,
          detail: "autenticazione fallita (401): verifica email Atlassian e token",
        };
      }
      if (r.status === 403) {
        return {
          name: CHECK,
          ok: false,
          detail:
            "accesso negato (403): il token non ha accesso a questo workspace o manca lo scope repository",
        };
      }
      if (r.status === 404) {
        return {
          name: CHECK,
          ok: false,
          detail: `workspace «${workspace}» non trovato: verifica lo slug`,
        };
      }
      if (r.status === 410) {
        return {
          name: CHECK,
          ok: false,
          detail: "endpoint non disponibile (410)",
        };
      }
      return {
        name: CHECK,
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
      // created/updated alimentano l'automazione PR Review; fulfilled/rejected
      // e repo:push servono al tracking dei fix; changes_request_created al
      // ciclo di correzione ("Request changes" sulla PR). I webhook già
      // configurati vanno riallineati rilanciando ensureWebhook (idempotente):
      // dalla UI con "Configura webhook" o con lo script resync-webhooks.
      events: [
        "pullrequest:created",
        "pullrequest:updated",
        "pullrequest:fulfilled",
        "pullrequest:rejected",
        "pullrequest:changes_request_created",
        "repo:push",
      ],
      secret: hook.secret,
    };

    try {
      // Cerca un hook con lo stesso target URL su TUTTE le pagine (cursore
      // `next`): uno in seconda pagina non trovato diventerebbe un duplicato
      // alla creazione qui sotto.
      const existing = await this.findHookByUrl(fetchImpl, `${base}?pagelen=100`, auth, hook.url);

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
    config: AccountConfig,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<RepoSummary[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;

    // CHANGE-2770: l'endpoint globale GET /2.0/repositories?role=member (e tutti
    // gli endpoint account) sono DISMESSI (410 Gone) per gli API token. Si può
    // elencare solo per workspace: GET /2.0/repositories/{workspace}. Senza il
    // workspace non possiamo enumerare nulla → errore esplicito.
    const workspace = config.workspace;
    if (!workspace) {
      throw new GitProviderError("workspace Bitbucket mancante", 0, "");
    }
    const auth = this.restAuthHeader(config.credentials);

    const repos: RepoSummary[] = [];
    let url: string | null = `${API_BASE}/repositories/${encodeURIComponent(
      workspace
    )}?pagelen=100&sort=-updated_on`;
    for (let page = 0; page < MAX_REPO_PAGES && url && repos.length < MAX_TOTAL_REPOS; page++) {
      // Il `next` lo sceglie la risposta: mai seguirlo fuori dall'API col token.
      assertPageOnApiHost(url, API_BASE, "Bitbucket");
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
        if (repos.length >= MAX_TOTAL_REPOS) break;
        if (typeof r.full_name !== "string" || typeof r.name !== "string") continue;
        const httpsClone = (r.links?.clone ?? []).find((c) => c.name === "https");
        const cloneUrl =
          typeof httpsClone?.href === "string"
            ? httpsClone.href
            : `https://bitbucket.org/${r.full_name}.git`;
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
      // Il `next` lo sceglie la risposta: mai seguirlo fuori dall'API col token.
      assertPageOnApiHost(url, API_BASE, "Bitbucket");
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
  private restAuthHeader(creds: AccountCredentials): string {
    const restUser = creds.credentials.email ?? creds.credentials.username;
    if (!restUser) {
      throw new GitProviderError(
        "Per elencare i repository Bitbucket serve un'email Atlassian (API token) o uno username (app password legacy)",
        0,
        ""
      );
    }
    return basicAuthHeader(restUser, creds.credentials.token);
  }

  /**
   * Header Basic per la REST API a partire dalla config di progetto: identità
   * = email Atlassian (API token) o, in fallback, username (app password
   * legacy). Stessa regola di openPullRequest/restAuthHeader; lancia se
   * mancano entrambe, prima di qualsiasi richiesta.
   */
  private projectRestAuthHeader(p: Pick<ProjectGitConfig, "credentials">): string {
    const restUser = p.credentials.email ?? p.credentials.username;
    if (!restUser) {
      throw new GitProviderError(
        "Bitbucket REST credentials require an email (API tokens) or a username (legacy app passwords)",
        0,
        ""
      );
    }
    return basicAuthHeader(restUser, p.credentials.token);
  }

  /**
   * Cerca fra gli hook del repository quello con `url` uguale a `targetUrl`,
   * seguendo il cursore `next` fino a {@link MAX_HOOK_PAGES}. Si ferma alla
   * prima pagina che lo contiene. Lancia GitProviderError (mai `undefined`,
   * che al chiamante varrebbe «crealo») su una risposta dalla forma inattesa
   * (`values` non array), su una pagina successiva oltre il tetto e su un
   * `next` fuori dall'host dell'API — quest'ultimo PRIMA di seguirlo, perché
   * la richiesta porterebbe il token altrove.
   */
  private async findHookByUrl(
    fetchImpl: FetchLike,
    firstUrl: string,
    auth: string,
    targetUrl: string
  ): Promise<{ uuid?: unknown; url?: unknown } | undefined> {
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_HOOK_PAGES && url; page++) {
      assertPageOnApiHost(url, API_BASE, "Bitbucket");
      const response = await fetchImpl(url, { method: "GET", headers: { Authorization: auth } });
      this.guardWebhookResponse(response);
      const data = (await readJsonResponse(response, "Bitbucket")) as {
        values?: unknown;
        next?: unknown;
      } | null;
      if (!data || typeof data !== "object" || !Array.isArray(data.values)) {
        throw new GitProviderError(
          "Bitbucket: risposta inattesa leggendo i webhook del repository: non ne creo uno nuovo alla cieca",
          0,
          ""
        );
      }
      const found = (data.values as { uuid?: unknown; url?: unknown }[]).find(
        (h) => h?.url === targetUrl
      );
      if (found) return found;
      url = typeof data.next === "string" ? data.next : null;
    }
    if (url) {
      throw new GitProviderError(
        `Bitbucket: oltre ${MAX_HOOK_PAGES} pagine di webhook sul repository: non ne creo uno nuovo per non duplicarlo`,
        0,
        ""
      );
    }
    return undefined;
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

/** Mappa `state` di un build status Bitbucket sul rollup a tre stati condiviso. */
function bitbucketCheckStatus(state: unknown): CheckOutcomeStatus {
  if (state === "SUCCESSFUL") return "success";
  if (state === "INPROGRESS") return "pending";
  return "failure"; // FAILED, STOPPED, o qualunque valore non riconosciuto.
}

/**
 * Identità di un account Bitbucket da un payload (webhook o REST): uuid (con
 * le graffe, com'è) come id stabile, `nickname` come nome leggibile —
 * `display_name` se manca, l'uuid come ultima risorsa. Null senza uuid:
 * un'identità che non si può confrontare con gli account di Stubwise non
 * vale niente per il filtro del design §5.
 */
function bitbucketAccount(raw: unknown): { id: string; login: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const account = raw as { uuid?: unknown; nickname?: unknown; display_name?: unknown };
  if (typeof account.uuid !== "string" || account.uuid.length === 0) return null;
  const login =
    typeof account.nickname === "string" && account.nickname.length > 0
      ? account.nickname
      : typeof account.display_name === "string" && account.display_name.length > 0
        ? account.display_name
        : account.uuid;
  return { id: account.uuid, login };
}

/**
 * Un commento REST di Bitbucket → {@link PrComment}, o null se non va nella
 * fotografia (cancellato, bozza, vuoto, senza id/data/autore). L'autore passa
 * da {@link bitbucketAccount}, la stessa funzione del webhook "Request
 * changes": l'identità Bitbucket ha UNA forma sola (uuid grezzo con le
 * graffe), confrontabile con gli account di Stubwise. La riga è `inline.to`
 * (versione nuova del file) e, se manca, `inline.from` (riga tolta); nessuna
 * riga per un commento generale.
 */
function bitbucketComment(c: BitbucketCommentPayload): PrComment | null {
  if (typeof c !== "object" || c === null) return null;
  if (c.deleted === true || c.pending === true) return null;
  if (typeof c.id !== "number" || typeof c.created_on !== "string") return null;
  const body = typeof c.content?.raw === "string" ? c.content.raw : "";
  if (body.trim().length === 0) return null;
  const author = bitbucketAccount(c.user);
  if (author === null) return null;
  const path = typeof c.inline?.path === "string" ? c.inline.path : null;
  const line =
    path === null
      ? null
      : typeof c.inline?.to === "number"
        ? c.inline.to
        : typeof c.inline?.from === "number"
          ? c.inline.from
          : null;
  return {
    id: String(c.id),
    authorId: author.id,
    authorLogin: author.login,
    body,
    createdAt: c.created_on,
    path,
    line,
    // Nessun equivalente di `author_association` su Bitbucket.
    authorAssociation: null,
  };
}
