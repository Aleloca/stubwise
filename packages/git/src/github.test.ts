import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import {
  GitProviderError,
  MergeNotAllowedError,
  type AccountCredentials,
  type ProjectGitConfig,
} from "./provider.js";

const config: ProjectGitConfig = {
  repoUrl: "https://github.com/octo/repo",
  defaultBranch: "main",
  credentials: { token: "ghp_secret" },
};

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHubProvider.getCloneUrl", () => {
  const provider = new GitHubProvider();

  it("embeds the token with x-access-token user in the https clone URL", () => {
    expect(provider.getCloneUrl(config)).toBe("https://x-access-token:ghp_secret@github.com/octo/repo.git");
  });

  it("handles trailing .git and trailing slash in repoUrl", () => {
    expect(provider.getCloneUrl({ ...config, repoUrl: "https://github.com/octo/repo.git" })).toBe(
      "https://x-access-token:ghp_secret@github.com/octo/repo.git"
    );
    expect(provider.getCloneUrl({ ...config, repoUrl: "https://github.com/octo/repo/" })).toBe(
      "https://x-access-token:ghp_secret@github.com/octo/repo.git"
    );
  });

  it("percent-encodes the token", () => {
    expect(provider.getCloneUrl({ ...config, credentials: { token: "a/b:c" } })).toBe(
      "https://x-access-token:a%2Fb%3Ac@github.com/octo/repo.git"
    );
  });

  it("throws a clear error on unparsable repoUrl", () => {
    expect(() => provider.getCloneUrl({ ...config, repoUrl: "https://github.com/onlyowner" })).toThrow(
      /repo url/i
    );
    expect(() => provider.getCloneUrl({ ...config, repoUrl: "nope" })).toThrow(/repo url/i);
  });
});

describe("GitHubProvider.getAuthHeader", () => {
  const provider = new GitHubProvider();

  it("returns Basic auth with the x-access-token user (git smart-http endpoints want Basic, not Bearer)", () => {
    // base64("x-access-token:ghp_secret")
    expect(provider.getAuthHeader(config)).toBe("Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==");
  });

  it("encodes the raw token verbatim (no percent-encoding before base64)", () => {
    expect(provider.getAuthHeader({ ...config, credentials: { token: "a/b:c" } })).toBe(
      `Basic ${Buffer.from("x-access-token:a/b:c").toString("base64")}`
    );
  });
});

describe("GitHubProvider.openPullRequest", () => {
  it("POSTs to the GitHub API with Bearer auth and the correct body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ html_url: "https://github.com/octo/repo/pull/42" }));
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.openPullRequest(config, {
      branch: "stubwise/fix-1",
      title: "Fix the bug",
      body: "Closes #1",
    });

    expect(result).toEqual({ url: "https://github.com/octo/repo/pull/42" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/repo/pulls");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Fix the bug",
      body: "Closes #1",
      head: "stubwise/fix-1",
      base: "main",
    });
  });

  it("throws GitProviderError with status and truncated response text on non-2xx", async () => {
    const longText = "y".repeat(600);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(longText, { status: 422 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .openPullRequest(config, { branch: "b", title: "t", body: "b" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    const gpError = error as GitProviderError;
    expect(gpError.status).toBe(422);
    expect(gpError.responseText).toBe("y".repeat(500));
    expect(gpError.message).toContain("422");
  });

  it("throws GitProviderError when a 2xx response is missing html_url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 42 }, 200));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .openPullRequest(config, { branch: "b", title: "t", body: "b" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    const gpError = error as GitProviderError;
    expect(gpError.status).toBe(200);
    expect(gpError.message).toMatch(/html_url/);
  });

  it("throws GitProviderError when a 2xx response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .openPullRequest(config, { branch: "b", title: "t", body: "b" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    const gpError = error as GitProviderError;
    expect(gpError.status).toBe(200);
    expect(gpError.message).toMatch(/JSON/i);
  });
});

describe("GitHubProvider.getPullRequestState", () => {
  it("state=open → 'open'; state=closed → 'closed'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state: "open" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getPullRequestState(config, 42)).resolves.toBe("open");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/pulls/42",
      expect.objectContaining({ method: "GET" })
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");

    const closedFetch = vi.fn().mockResolvedValue(jsonResponse({ state: "closed" }, 200));
    const closedProvider = new GitHubProvider({ fetchImpl: closedFetch });
    await expect(closedProvider.getPullRequestState(config, 42)).resolves.toBe("closed");
  });

  it("throws GitProviderError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .getPullRequestState(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(404);
  });
});

describe("GitHubProvider.getPullRequestFinalState", () => {
  async function stateOf(body: unknown): Promise<unknown> {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body, 200));
    return new GitHubProvider({ fetchImpl })
      .getPullRequestFinalState(config, 42)
      .catch((e: unknown) => e);
  }

  it("open, mergiata e chiusa senza merge si distinguono", async () => {
    await expect(stateOf({ state: "open", merged: false })).resolves.toBe("open");
    await expect(stateOf({ state: "closed", merged: true, merged_at: "2026-09-01T00:00:00Z" })).resolves.toBe("merged");
    await expect(stateOf({ state: "closed", merged: false, merged_at: null })).resolves.toBe("closed_unmerged");
    // Senza `merged`, vale `merged_at`.
    await expect(stateOf({ state: "closed", merged_at: "2026-09-01T00:00:00Z" })).resolves.toBe("merged");
    await expect(stateOf({ state: "closed", merged_at: null })).resolves.toBe("closed_unmerged");
  });

  it("una risposta che non dice se è mergiata lancia: non si deduce", async () => {
    const error = await stateOf({ state: "closed" });
    expect(error).toBeInstanceOf(GitProviderError);
    expect(await stateOf({ state: "boh" })).toBeInstanceOf(GitProviderError);
  });

  it("404 → GitProviderError con lo status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const error = await new GitHubProvider({ fetchImpl })
      .getPullRequestFinalState(config, 42)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/pulls/42",
      expect.objectContaining({ method: "GET" })
    );
  });
});

describe("GitHubProvider.getPullRequestChecks", () => {
  function fetchSequence(prResponse: Response, checksResponse: Response) {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(prResponse).mockResolvedValueOnce(checksResponse);
    return fetchImpl;
  }

  it("tutti verdi → status success", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      jsonResponse(
        {
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "test", status: "completed", conclusion: "success" },
          ],
        },
        200
      )
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);

    expect(result).toEqual({
      status: "success",
      checks: [
        { name: "build", status: "success" },
        { name: "test", status: "success" },
      ],
      headSha: "abc123",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/octo/repo/commits/abc123/check-runs?per_page=100",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("un check rosso → status failure, anche se gli altri sono verdi", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      jsonResponse(
        {
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "test", status: "completed", conclusion: "failure" },
          ],
        },
        200
      )
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result.status).toBe("failure");
    expect(result.checks).toContainEqual({ name: "test", status: "failure" });
  });

  it("un check ancora in corso (non completed) → status pending", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      jsonResponse({ check_runs: [{ name: "build", status: "in_progress", conclusion: null }] }, 200)
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result).toEqual({
      status: "pending",
      checks: [{ name: "build", status: "pending" }],
      headSha: "abc123",
    });
  });

  it("nessun check configurato → 'no_checks', DIVERSO da 'failure' e da 'unknown'", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      jsonResponse({ check_runs: [] }, 200)
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result).toEqual({ status: "no_checks", checks: [], headSha: "abc123" });
  });

  it("errore di rete: non lancia, ricade su 'unknown' — DIVERSO da 'no_checks' (review fix Task 2)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result).toEqual({ status: "unknown", checks: [] });
  });

  it("PR inesistente (404 sul fetch della PR): non lancia, ricade su 'unknown', senza headSha", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result).toEqual({ status: "unknown", checks: [] });
  });

  it("401 sul fetch dei check-run (PR già risolta): 'unknown' CON headSha", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      new Response("unauthorized", { status: 401 })
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result).toEqual({ status: "unknown", checks: [], headSha: "abc123" });
  });

  it("neutral/skipped non bloccano il rollup", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123" } }, 200),
      jsonResponse(
        {
          check_runs: [
            { name: "lint", status: "completed", conclusion: "neutral" },
            { name: "build", status: "completed", conclusion: "success" },
          ],
        },
        200
      )
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result.status).toBe("success");
    expect(result.headSha).toBe("abc123");
  });

  it("head.ref della PR → headRef (review fix Task 1, etichetta della coda per le PR esterne)", async () => {
    const fetchImpl = fetchSequence(
      jsonResponse({ head: { sha: "abc123", ref: "fix/typo-in-readme" } }, 200),
      jsonResponse({ check_runs: [] }, 200)
    );
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 42);
    expect(result.headRef).toBe("fix/typo-in-readme");
  });
});

describe("GitHubProvider.mergePullRequest", () => {
  it("PUT .../merge con merge_method: 'merge' → { merged: true, sha }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ merged: true, sha: "deadbeef" }, 200));
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.mergePullRequest(config, 42);

    expect(result).toEqual({ merged: true, sha: "deadbeef" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/repo/pulls/42/merge");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ merge_method: "merge" });
  });

  it("405 → MergeNotAllowedError con reason 'not_mergeable'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("blocked", { status: 405 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("not_mergeable");
  });

  it("409 (testa cambiata) → MergeNotAllowedError con reason 'not_mergeable'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("stale", { status: 409 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("not_mergeable");
  });

  it("403 → MergeNotAllowedError con reason 'forbidden'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("forbidden");
  });

  it("404 → MergeNotAllowedError con reason 'forbidden'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("forbidden");
  });

  it("status non riconosciuto → MergeNotAllowedError con reason 'unknown'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("unknown");
  });

  it("2xx senza merged:true/sha → MergeNotAllowedError con reason 'unknown' (mai lancia un tipo diverso)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ merged: false }, 200));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("unknown");
  });
});

describe("GitHubProvider.createPrComment", () => {
  it("POST di un commento nuovo, senza leggere né modificare quelli esistenti", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 2 }, 201));
    const provider = new GitHubProvider({ fetchImpl });

    await provider.createPrComment(config, 42, "Analisi");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/issues/42/comments",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ body: "Analisi" });
  });

  it("throws GitProviderError when the create call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .createPrComment(config, 42, "testo")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
  });
});

describe("GitHubProvider.listPrComments", () => {
  const BASE = "https://api.github.com/repos/octo/repo";
  const ISSUE_URL = `${BASE}/issues/42/comments?per_page=100`;
  const REVIEW_COMMENTS_URL = `${BASE}/pulls/42/comments?per_page=100`;
  const REVIEWS_URL = `${BASE}/pulls/42/reviews?per_page=100`;
  const mario = { id: 12345, login: "mario-rossi" };

  function pagedResponse(body: unknown, next?: string): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(next ? { link: `<${next}>; rel="next"` } : {}),
      },
    });
  }

  function routes(pages: Record<string, () => Response>) {
    return vi.fn().mockImplementation((input: string | URL) => {
      const handler = pages[String(input)];
      return Promise.resolve(handler ? handler() : new Response("", { status: 404 }));
    });
  }

  it("unisce conversazione, righe e testo delle review, ordinati per data", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([
          { id: 1, user: mario, body: "Generale", created_at: "2026-09-30T10:03:00Z", author_association: "OWNER" },
        ]),
      [REVIEW_COMMENTS_URL]: () =>
        pagedResponse([
          {
            id: 2,
            user: mario,
            body: "Null check",
            created_at: "2026-09-30T10:01:00Z",
            path: "src/a.ts",
            line: 42,
            original_line: 40,
            author_association: "MEMBER",
          },
          {
            id: 3,
            user: mario,
            body: "Riga non più nel diff",
            created_at: "2026-09-30T10:02:00Z",
            path: "src/b.ts",
            line: null,
            original_line: 9,
          },
        ]),
      [REVIEWS_URL]: () =>
        pagedResponse([
          {
            id: 4,
            user: mario,
            body: "Nel complesso ok",
            state: "COMMENTED",
            submitted_at: "2026-09-30T10:00:00Z",
            author_association: "COLLABORATOR",
          },
          { id: 5, user: mario, body: "", state: "APPROVED", submitted_at: "2026-09-30T10:04:00Z" },
          { id: 6, user: mario, body: "bozza", state: "PENDING" },
        ]),
    });
    const provider = new GitHubProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 42);

    const calledUrls = fetchImpl.mock.calls.map((c) => String((c as [string])[0]));
    expect(calledUrls).toEqual([ISSUE_URL, REVIEW_COMMENTS_URL, REVIEWS_URL]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/vnd.github+json");
    expect(comments).toEqual([
      {
        id: "review-4",
        authorId: "12345",
        authorLogin: "mario-rossi",
        body: "Nel complesso ok",
        createdAt: "2026-09-30T10:00:00Z",
        path: null,
        line: null,
        authorAssociation: "COLLABORATOR",
      },
      {
        id: "review-comment-2",
        authorId: "12345",
        authorLogin: "mario-rossi",
        body: "Null check",
        createdAt: "2026-09-30T10:01:00Z",
        path: "src/a.ts",
        line: 42,
        authorAssociation: "MEMBER",
      },
      {
        id: "review-comment-3",
        authorId: "12345",
        authorLogin: "mario-rossi",
        body: "Riga non più nel diff",
        createdAt: "2026-09-30T10:02:00Z",
        path: "src/b.ts",
        line: 9,
        // campo assente nella risposta → sconosciuto
        authorAssociation: null,
      },
      {
        id: "issue-1",
        authorId: "12345",
        authorLogin: "mario-rossi",
        body: "Generale",
        createdAt: "2026-09-30T10:03:00Z",
        path: null,
        line: null,
        authorAssociation: "OWNER",
      },
    ]);
  });

  it("una review in bozza (PENDING) non entra, anche se ha testo e data", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () => pagedResponse([]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse([]),
      [REVIEWS_URL]: () =>
        pagedResponse([
          { id: 7, user: mario, body: "bozza con data", state: "PENDING", submitted_at: "2026-09-30T10:00:00Z" },
          { id: 8, user: mario, body: "   ", state: "APPROVED", submitted_at: "2026-09-30T10:01:00Z" },
          { id: 9, user: mario, body: null, state: "APPROVED", submitted_at: "2026-09-30T10:02:00Z" },
        ]),
    });
    const provider = new GitHubProvider({ fetchImpl });
    expect(await provider.listPrComments(config, 42)).toEqual([]);
  });

  it("scarta i commenti senza autore riconoscibile (user null: account cancellato)", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([{ id: 1, user: null, body: "fantasma", created_at: "2026-09-30T10:00:00Z" }]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse([]),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });
    expect(await provider.listPrComments(config, 42)).toEqual([]);
  });

  it("authorId è sempre l'id numerico, mai il login; un id non intero sicuro scarta il commento, in tutte e tre le fonti", async () => {
    const at = "2026-09-30T10:00:00Z";
    const badUsers = [
      { id: "12345", login: "mario-rossi" },
      { id: 1.5, login: "mario-rossi" },
      { id: Number.MAX_SAFE_INTEGER + 2, login: "mario-rossi" },
      { login: "mario-rossi" },
    ];
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([
          ...badUsers.map((user, i) => ({ id: 100 + i, user, body: "x", created_at: at })),
          { id: 1, user: mario, body: "buono", created_at: at },
        ]),
      [REVIEW_COMMENTS_URL]: () =>
        pagedResponse([
          ...badUsers.map((user, i) => ({ id: 200 + i, user, body: "x", created_at: at, path: "a.ts", line: 1 })),
          { id: 2, user: mario, body: "buono", created_at: at, path: "a.ts", line: 1 },
        ]),
      [REVIEWS_URL]: () =>
        pagedResponse([
          ...badUsers.map((user, i) => ({ id: 300 + i, user, body: "x", state: "COMMENTED", submitted_at: at })),
          { id: 3, user: mario, body: "buono", state: "COMMENTED", submitted_at: at },
        ]),
    });
    const provider = new GitHubProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 42);

    expect(comments.map((c) => c.id).sort()).toEqual(["issue-1", "review-3", "review-comment-2"]);
    for (const c of comments) {
      expect(c.authorId).toBe("12345");
      expect(c.authorLogin).toBe("mario-rossi");
    }
  });

  it("sulla stessa utenza, authorId dei commenti coincide con l'actorId del webhook \"Request changes\"", async () => {
    const user = { id: 987654321, login: "lucia-bianchi" };
    const fetchImpl = routes({
      [ISSUE_URL]: () => pagedResponse([{ id: 1, user, body: "a", created_at: "2026-09-30T10:00:00Z" }]),
      [REVIEW_COMMENTS_URL]: () =>
        pagedResponse([{ id: 2, user, body: "b", created_at: "2026-09-30T10:01:00Z", path: "a.ts", line: 3 }]),
      [REVIEWS_URL]: () =>
        pagedResponse([{ id: 3, user, body: "c", state: "CHANGES_REQUESTED", submitted_at: "2026-09-30T10:02:00Z" }]),
    });
    const provider = new GitHubProvider({ fetchImpl });

    const event = provider.parseChangesRequestedEvent(
      { "x-github-event": "pull_request_review" },
      {
        action: "submitted",
        review: { state: "changes_requested", body: "c", user },
        pull_request: { number: 42, head: { ref: "stubwise/ticket-7" } },
      }
    );
    const comments = await provider.listPrComments(config, 42);

    expect(event).not.toBeNull();
    expect(comments).toHaveLength(3);
    for (const c of comments) {
      expect(c.authorId).toBe(event?.actorId);
      expect(c.authorLogin).toBe(event?.actorLogin);
    }
  });

  it("segue l'header Link rel=next", async () => {
    const ISSUE_PAGE_2 = `${BASE}/issues/42/comments?per_page=100&page=2`;
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([{ id: 1, user: mario, body: "p1", created_at: "2026-09-30T10:00:00Z" }], ISSUE_PAGE_2),
      [ISSUE_PAGE_2]: () =>
        pagedResponse([{ id: 2, user: mario, body: "p2", created_at: "2026-09-30T10:01:00Z" }]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse([]),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });
    const comments = await provider.listPrComments(config, 42);
    expect(comments.map((c) => c.id)).toEqual(["issue-1", "issue-2"]);
  });

  it("un Link next verso un host diverso dall'API GitHub non viene seguito: il token non esce", async () => {
    const EVIL = "https://evil.example.com/repos/octo/repo/issues/42/comments?page=2";
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([{ id: 1, user: mario, body: "p1", created_at: "2026-09-30T10:00:00Z" }], EVIL),
      [EVIL]: () => pagedResponse([]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse([]),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .listPrComments(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
    const calledUrls = fetchImpl.mock.calls.map((c) => String((c as [string])[0]));
    expect(calledUrls).not.toContain(EVIL);
    expect(calledUrls.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
  });

  it("un Link next oltre il tetto di 10 pagine per fonte → GitProviderError, mai una fotografia a metà", async () => {
    const fetchImpl = vi.fn().mockImplementation((input: string | URL) =>
      Promise.resolve(
        String(input).includes("/issues/")
          ? pagedResponse(
              [{ id: 1, user: mario, body: "x", created_at: "2026-09-30T10:00:00Z" }],
              `${BASE}/issues/42/comments?per_page=100&page=n`
            )
          : pagedResponse([])
      )
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.listPrComments(config, 42).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/oltre 10 pagine/);
    const issueCalls = fetchImpl.mock.calls.filter((c) => String((c as [string])[0]).includes("/issues/"));
    expect(issueCalls).toHaveLength(10);
  });

  it("un corpo che non è un array → GitProviderError (risposta inattesa), non \"nessun commento\"", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () => pagedResponse([{ id: 1, user: mario, body: "p1", created_at: "2026-09-30T10:00:00Z" }]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse({ message: "boh" }),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.listPrComments(config, 42).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/risposta inattesa/);
  });

  it("non-2xx su una fonte → GitProviderError (niente fotografia a metà)", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () => pagedResponse([]),
      [REVIEW_COMMENTS_URL]: () => new Response("forbidden", { status: 403 }),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .listPrComments(config, 42)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
  });
  it("una data non leggibile non si scarta: va in fondo, nell'ordine d'arrivo, e non scompiglia le altre", async () => {
    const fetchImpl = routes({
      [ISSUE_URL]: () =>
        pagedResponse([
          { id: 1, user: mario, body: "senza data buona A", created_at: "boh" },
          { id: 2, user: mario, body: "secondo", created_at: "2026-09-30T10:02:00Z" },
          { id: 3, user: mario, body: "senza data buona B", created_at: "non è una data" },
          { id: 4, user: mario, body: "primo", created_at: "2026-09-30T10:01:00Z" },
          { id: 5, user: mario, body: "terzo", created_at: "2026-09-30T10:03:00Z" },
        ]),
      [REVIEW_COMMENTS_URL]: () => pagedResponse([]),
      [REVIEWS_URL]: () => pagedResponse([]),
    });
    const provider = new GitHubProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 42);

    expect(comments.map((c) => c.id)).toEqual(["issue-4", "issue-2", "issue-5", "issue-1", "issue-3"]);
  });
});

describe("GitHubProvider.parseWebhook", () => {
  const provider = new GitHubProvider();
  const mergedBody = {
    action: "closed",
    pull_request: {
      number: 7,
      merged: true,
      head: { ref: "stubwise/fix-1" },
      html_url: "https://github.com/octo/repo/pull/42",
    },
  };

  it("recognizes pull_request closed+merged and extracts the head branch", () => {
    const event = provider.parseWebhook({ "X-GitHub-Event": "pull_request" }, mergedBody);
    expect(event).toEqual({
      kind: "merged",
      provider: "github",
      branch: "stubwise/fix-1",
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: 7,
    });
  });

  it("exposes the PR number as prNumber", () => {
    const event = provider.parseWebhook({ "x-github-event": "pull_request" }, mergedBody);
    expect(event?.prNumber).toBe(7);
  });

  it("matches the event header case-insensitively", () => {
    expect(provider.parseWebhook({ "x-github-event": "pull_request" }, mergedBody)).not.toBeNull();
  });

  it("returns null for other events or actions", () => {
    expect(provider.parseWebhook({ "x-github-event": "push" }, mergedBody)).toBeNull();
    expect(provider.parseWebhook({}, mergedBody)).toBeNull();
    expect(
      provider.parseWebhook({ "x-github-event": "pull_request" }, { ...mergedBody, action: "opened" })
    ).toBeNull();
  });

  it("recognizes a PR closed without merging as closed_unmerged", () => {
    const body = { ...mergedBody, pull_request: { ...mergedBody.pull_request, merged: false } };
    expect(provider.parseWebhook({ "x-github-event": "pull_request" }, body)).toEqual({
      kind: "closed_unmerged",
      provider: "github",
      branch: "stubwise/fix-1",
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: 7,
    });
  });

  it("returns null (does not throw) on malformed bodies", () => {
    const headers = { "x-github-event": "pull_request" };
    expect(provider.parseWebhook(headers, null)).toBeNull();
    expect(provider.parseWebhook(headers, 42)).toBeNull();
    expect(provider.parseWebhook(headers, { action: "closed" })).toBeNull();
    expect(provider.parseWebhook(headers, { action: "closed", pull_request: { merged: true } })).toBeNull();
  });

  it("PR number missing or not a number → evento valido con prNumber null", () => {
    // La chiusura del ticket dipende dal branch, non dal numero PR: un payload
    // senza `number` resta un evento valido, solo il cleanup review lo salterà.
    const headers = { "x-github-event": "pull_request" };
    const withoutNumber: Record<string, unknown> = { ...mergedBody.pull_request };
    delete withoutNumber["number"];
    const event = provider.parseWebhook(headers, { ...mergedBody, pull_request: withoutNumber });
    expect(event).toEqual({
      kind: "merged",
      provider: "github",
      branch: "stubwise/fix-1",
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: null,
    });
    expect(
      provider.parseWebhook(headers, {
        ...mergedBody,
        pull_request: { ...mergedBody.pull_request, number: "7" },
      })?.prNumber
    ).toBeNull();
  });
});

describe("GitHubProvider.parsePrEvent", () => {
  const provider = new GitHubProvider();
  const payload = (action: string) => ({
    action,
    pull_request: {
      number: 42,
      title: "Add login",
      body: "Implements login flow",
      html_url: "https://github.com/acme/repo/pull/42",
      head: { ref: "feature/login", sha: "a".repeat(40) },
      base: { ref: "main" },
    },
  });
  const headers = { "x-github-event": "pull_request" };

  it("action=opened → kind opened con tutti i campi", () => {
    expect(provider.parsePrEvent(headers, payload("opened"))).toEqual({
      kind: "opened",
      provider: "github",
      prNumber: 42,
      title: "Add login",
      description: "Implements login flow",
      sourceBranch: "feature/login",
      targetBranch: "main",
      headSha: "a".repeat(40),
      prUrl: "https://github.com/acme/repo/pull/42",
    });
  });

  it("action=reopened → opened; synchronize → updated", () => {
    expect(provider.parsePrEvent(headers, payload("reopened"))?.kind).toBe("opened");
    expect(provider.parsePrEvent(headers, payload("synchronize"))?.kind).toBe("updated");
  });

  it("reopened segnala `reopened: true`; opened e synchronize NON hanno il campo", () => {
    expect(provider.parsePrEvent(headers, payload("reopened"))?.reopened).toBe(true);
    expect(provider.parsePrEvent(headers, payload("opened"))).not.toHaveProperty("reopened");
    expect(provider.parsePrEvent(headers, payload("synchronize"))).not.toHaveProperty("reopened");
  });

  it("action=closed o evento non-PR → null; body null → null", () => {
    expect(provider.parsePrEvent(headers, payload("closed"))).toBeNull();
    expect(provider.parsePrEvent({ "x-github-event": "push" }, payload("opened"))).toBeNull();
    expect(provider.parsePrEvent(headers, null)).toBeNull();
  });

  it("body PR null → description stringa vuota", () => {
    const p = payload("opened");
    (p.pull_request as { body: unknown }).body = null;
    expect(provider.parsePrEvent(headers, p)?.description).toBe("");
  });

  it("campi obbligatori mancanti → null", () => {
    const p = payload("opened");
    (p.pull_request as { head: unknown }).head = { ref: "feature/login" };
    expect(provider.parsePrEvent(headers, p)).toBeNull();
    expect(provider.parsePrEvent(headers, { action: "opened" })).toBeNull();
  });
});

describe("GitHubProvider.parseChangesRequestedEvent", () => {
  const provider = new GitHubProvider();
  const headers = { "x-github-event": "pull_request_review" };
  const payload = (state = "changes_requested", action = "submitted") => ({
    action,
    review: {
      id: 900,
      state,
      body: "Manca la gestione dell'errore 404",
      user: { id: 12345, login: "mario-rossi" },
      author_association: "OWNER",
      commit_id: "a".repeat(40),
    },
    pull_request: {
      number: 42,
      head: { ref: "stubwise/ticket-7", sha: "a".repeat(40) },
      base: { ref: "main" },
      html_url: "https://github.com/octo/repo/pull/42",
    },
    sender: { id: 12345, login: "mario-rossi" },
  });

  it("submitted + changes_requested → PR, branch, autore (id come stringa), testo", () => {
    expect(provider.parseChangesRequestedEvent(headers, payload())).toEqual({
      prNumber: 42,
      sourceBranch: "stubwise/ticket-7",
      actorId: "12345",
      actorLogin: "mario-rossi",
      reviewBody: "Manca la gestione dell'errore 404",
      authorAssociation: "OWNER",
    });
  });

  it("author_association: passato così com'è (NONE incluso); assente, vuoto o non stringa → null", () => {
    const none = payload();
    (none.review as { author_association: unknown }).author_association = "NONE";
    expect(provider.parseChangesRequestedEvent(headers, none)?.authorAssociation).toBe("NONE");
    for (const value of [undefined, "", 7, null]) {
      const p = payload();
      if (value === undefined) delete (p.review as { author_association?: unknown }).author_association;
      else (p.review as { author_association: unknown }).author_association = value;
      const event = provider.parseChangesRequestedEvent(headers, p);
      // l'evento resta valido: la decisione su chi è ammesso si prende a valle
      expect(event).not.toBeNull();
      expect(event?.authorAssociation).toBeNull();
    }
  });

  it("stato maiuscolo (forma REST) accettato; header case-insensitive", () => {
    expect(
      provider.parseChangesRequestedEvent({ "X-GitHub-Event": "pull_request_review" }, payload("CHANGES_REQUESTED"))
    ).not.toBeNull();
  });

  it("body null o vuoto → reviewBody null", () => {
    const p = payload();
    (p.review as { body: unknown }).body = null;
    expect(provider.parseChangesRequestedEvent(headers, p)?.reviewBody).toBeNull();
    (p.review as { body: unknown }).body = "   ";
    expect(provider.parseChangesRequestedEvent(headers, p)?.reviewBody).toBeNull();
  });

  it("approved, commented, dismissed, edited → null", () => {
    expect(provider.parseChangesRequestedEvent(headers, payload("approved"))).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, payload("commented"))).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, payload("changes_requested", "dismissed"))).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, payload("changes_requested", "edited"))).toBeNull();
  });

  it("altri eventi → null, e gli altri parser non vedono questo evento", () => {
    expect(provider.parseChangesRequestedEvent({ "x-github-event": "pull_request" }, payload())).toBeNull();
    expect(provider.parsePrEvent(headers, payload())).toBeNull();
    expect(provider.parseWebhook(headers, payload())).toBeNull();
    expect(provider.parsePushEvent(headers, payload())).toBeNull();
  });

  it("campi obbligatori mancanti o body malformato → null, senza lanciare", () => {
    const noUser = payload();
    (noUser.review as { user: unknown }).user = null;
    expect(provider.parseChangesRequestedEvent(headers, noUser)).toBeNull();
    const noRef = payload();
    (noRef.pull_request as { head: unknown }).head = {};
    expect(provider.parseChangesRequestedEvent(headers, noRef)).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, null)).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, { action: "submitted" })).toBeNull();
  });

  it("numero della PR non intero → null", () => {
    const p = payload();
    (p.pull_request as { number: unknown }).number = 1.5;
    expect(provider.parseChangesRequestedEvent(headers, p)).toBeNull();
  });

  it("id dell'autore non intero → null", () => {
    const p = payload();
    (p.review.user as { id: unknown }).id = 1.5;
    expect(provider.parseChangesRequestedEvent(headers, p)).toBeNull();
  });
});

describe("GitHubProvider.parsePushEvent", () => {
  const provider = new GitHubProvider();
  const pushBody = {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    commits: [
      { id: "c".repeat(40), message: "first commit" },
      { id: "d".repeat(40), message: "second commit" },
    ],
  };

  it("recognizes a branch push and maps branch, before/after and commits", () => {
    const event = provider.parsePushEvent({ "X-GitHub-Event": "push" }, pushBody);
    expect(event).toEqual({
      branch: "main",
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      commits: [
        { sha: "c".repeat(40), message: "first commit" },
        { sha: "d".repeat(40), message: "second commit" },
      ],
    });
  });

  it("matches the event header case-insensitively and strips refs/heads/ on nested branches", () => {
    const event = provider.parsePushEvent(
      { "x-github-event": "push" },
      { ...pushBody, ref: "refs/heads/feature/x" }
    );
    expect(event?.branch).toBe("feature/x");
  });

  it("treats a new branch (before = 0*40) correctly", () => {
    const event = provider.parsePushEvent(
      { "x-github-event": "push" },
      { ...pushBody, before: "0".repeat(40) }
    );
    expect(event?.beforeSha).toBe("0".repeat(40));
  });

  it("defaults commits to [] when absent or malformed", () => {
    expect(
      provider.parsePushEvent({ "x-github-event": "push" }, { ref: "refs/heads/main", before: "a", after: "b" })
        ?.commits
    ).toEqual([]);
    expect(
      provider.parsePushEvent(
        { "x-github-event": "push" },
        { ref: "refs/heads/main", before: "a", after: "b", commits: [{ id: 1 }, { message: "no id" }, "x"] }
      )?.commits
    ).toEqual([]);
  });

  it("returns null for tag pushes (refs/tags/...)", () => {
    expect(
      provider.parsePushEvent({ "x-github-event": "push" }, { ...pushBody, ref: "refs/tags/v1.0.0" })
    ).toBeNull();
  });

  it("returns null when the event header is not push (a PR is not a push)", () => {
    const prBody = {
      action: "closed",
      pull_request: {
        merged: true,
        head: { ref: "stubwise/fix-1" },
        html_url: "https://github.com/octo/repo/pull/42",
      },
    };
    expect(provider.parsePushEvent({ "x-github-event": "pull_request" }, prBody)).toBeNull();
    expect(provider.parsePushEvent({}, pushBody)).toBeNull();
  });

  it("returns null (does not throw) on malformed bodies", () => {
    const headers = { "x-github-event": "push" };
    expect(provider.parsePushEvent(headers, null)).toBeNull();
    expect(provider.parsePushEvent(headers, 42)).toBeNull();
    expect(provider.parsePushEvent(headers, { before: "a", after: "b" })).toBeNull();
    expect(provider.parsePushEvent(headers, { ref: "refs/heads/main", before: "a" })).toBeNull();
    expect(provider.parsePushEvent(headers, { ref: 7, before: "a", after: "b" })).toBeNull();
  });

  it("cross-check: a PR webhook stays a PR — parseWebhook parses it, parsePushEvent does not", () => {
    const prBody = {
      action: "closed",
      pull_request: {
        number: 42,
        merged: true,
        head: { ref: "stubwise/fix-1" },
        html_url: "https://github.com/octo/repo/pull/42",
      },
    };
    expect(provider.parseWebhook({ "x-github-event": "pull_request" }, prBody)).not.toBeNull();
    expect(provider.parsePushEvent({ "x-github-event": "pull_request" }, prBody)).toBeNull();
  });
});

describe("GitHubProvider.validateCredentials", () => {
  const GIT_URL = "https://github.com/octo/repo.git/info/refs?service=git-receive-pack";
  const REST_URL = "https://api.github.com/repos/octo/repo";
  const HOOKS_URL = "https://api.github.com/repos/octo/repo/hooks?per_page=1";

  function routedFetch(map: { git?: () => Response; rest?: () => Response; hooks?: () => Response }) {
    return vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === GIT_URL) return Promise.resolve(map.git?.() ?? new Response("", { status: 500 }));
      if (url === REST_URL) return Promise.resolve(map.rest?.() ?? new Response("", { status: 500 }));
      if (url === HOOKS_URL) return Promise.resolve(map.hooks?.() ?? new Response("", { status: 500 }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
  }

  it("tutto ok: git 200 (Basic x-access-token), repo push:true (Bearer) e hooks 200", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => jsonResponse({ permissions: { push: true } }, 200),
      hooks: () => jsonResponse([], 200),
    });
    const provider = new GitHubProvider();
    const checks = await provider.validateCredentials(config, { fetchImpl });

    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[0]!.name).toBe("Accesso git (push)");
    expect(checks[1]!.name).toBe("Permessi repository (PR e merge)");
    expect(checks[2]!.name).toBe("Accesso webhook (config automatica)");

    const hooksCall = fetchImpl.mock.calls.find((c) => c[0] === HOOKS_URL) as unknown as [string, RequestInit];
    expect((hooksCall[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");

    const gitCall = fetchImpl.mock.calls.find((c) => c[0] === GIT_URL) as unknown as [string, RequestInit];
    expect((gitCall[1].headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`
    );
    const restCall = fetchImpl.mock.calls.find((c) => c[0] === REST_URL) as unknown as [string, RequestInit];
    expect((restCall[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
  });

  it("repo accessibile ma push:false: il check PR fallisce", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => jsonResponse({ permissions: { push: false } }, 200),
      hooks: () => jsonResponse([], 200),
    });
    const provider = new GitHubProvider();
    const checks = await provider.validateCredentials(config, { fetchImpl });

    const pr = checks.find((c) => c.name === "Permessi repository (PR e merge)")!;
    expect(pr.ok).toBe(false);
    expect(pr.detail).toMatch(/scrittura/i);
    // Il motivo è dichiarato, così chi decide non deve leggere il testo.
    expect(pr.failure).toBe("no_write_permission");
  });

  it("git 401: detail parla di token/scope", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 401 }),
      rest: () => jsonResponse({ permissions: { push: true } }, 200),
      hooks: () => jsonResponse([], 200),
    });
    const provider = new GitHubProvider();
    const checks = await provider.validateCredentials(config, { fetchImpl });

    const git = checks.find((c) => c.name === "Accesso git (push)")!;
    expect(git.ok).toBe(false);
    expect(git.detail).toMatch(/token|contents/i);
  });

  it("hooks 403: check webhook ok:false con guida sui permessi, advisory", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => jsonResponse({ permissions: { push: true } }, 200),
      hooks: () => new Response("", { status: 403 }),
    });
    const provider = new GitHubProvider();
    const checks = await provider.validateCredentials(config, { fetchImpl });

    expect(checks).toHaveLength(3);
    const webhook = checks.find((c) => c.name === "Accesso webhook (config automatica)")!;
    expect(webhook.ok).toBe(false);
    expect(webhook.detail).toMatch(/webhook/i);
  });

  it("errore di rete: i check falliscono senza lanciare", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const provider = new GitHubProvider();
    const checks = await provider.validateCredentials(config, { fetchImpl });

    expect(checks).toHaveLength(3);
    expect(checks.every((c) => !c.ok)).toBe(true);
    expect(checks[0]!.detail).toMatch(/network down/);
  });
});

describe("GitHubProvider.validateAccount", () => {
  const account = {
    credentials: { provider: "github", credentials: { token: "ghp_secret" } } satisfies AccountCredentials,
  };
  const ACCOUNT_URL = "https://api.github.com/user/repos?per_page=1";

  it("ignora il workspace (resta su /user/repos)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse([], 200)));
    const provider = new GitHubProvider();
    await provider.validateAccount({ ...account, workspace: "ignored" }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(ACCOUNT_URL);
  });

  it("200: un solo check ok, con Bearer + Accept github", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(jsonResponse([], 200));
    });
    const provider = new GitHubProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });

    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("Autenticazione e accesso repository");
    expect(checks[0]!.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ACCOUNT_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
  });

  it("401: check fallito (token non valido)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("bad", { status: 401 })));
    const provider = new GitHubProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/401/);
  });

  it("403: check fallito con messaggio sugli scope", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 403 })));
    const provider = new GitHubProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/scope/i);
  });

  it("errore di rete: il check fallisce senza lanciare", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const provider = new GitHubProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/network down/);
  });
});

describe("GitHubProvider.ensureWebhook", () => {
  const hook = { url: "https://stubwise.example.com/webhooks/git/demo", secret: "hmac-secret" };
  const LIST_URL = "https://api.github.com/repos/octo/repo/hooks";
  const PAGE1_URL = `${LIST_URL}?per_page=100`;
  const expectedBody = {
    name: "web",
    active: true,
    events: ["pull_request", "pull_request_review", "push"],
    config: { url: hook.url, content_type: "json", secret: hook.secret, insecure_ssl: "0" },
  };

  it("crea il webhook quando assente: POST con body e Bearer corretti", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PAGE1_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse([], 200));
      }
      if (url === LIST_URL && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: 42, config: { url: hook.url } }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.ensureWebhook(config, hook);

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.id).toBe("42");

    const post = fetchImpl.mock.calls.find((c) => c[1]?.method === "POST") as [string, RequestInit];
    expect(post[0]).toBe(LIST_URL);
    expect((post[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
    expect((post[1].headers as Record<string, string>)["Accept"]).toBe("application/vnd.github+json");
    expect(JSON.parse(post[1].body as string)).toEqual(expectedBody);
  });

  it("aggiorna il webhook esistente: PATCH all'id trovato per config.url", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      // L'hook già configurato ha la lista eventi VECCHIA: il riallineamento
      // (script resync-webhooks) deve riscriverla in place, senza duplicarlo.
      if (url === PAGE1_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          jsonResponse([{ id: 7, events: ["pull_request", "push"], config: { url: hook.url } }], 200)
        );
      }
      if (url === `${LIST_URL}/7` && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ id: 7, config: { url: hook.url } }, 200));
      }
      // Anche una creazione riceverebbe una risposta valida: un POST deve far
      // fallire l'asserzione "nessun duplicato", non il doppio.
      if (url === LIST_URL && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: 99, config: { url: hook.url } }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.ensureWebhook(config, hook);

    // Nessun duplicato: un solo aggiornamento in place, nessuna creazione.
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    const patches = fetchImpl.mock.calls.filter((c) => c[1]?.method === "PATCH");
    expect(patches).toHaveLength(1);

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("7");

    const patch = patches[0] as [string, RequestInit];
    expect(patch[0]).toBe(`${LIST_URL}/7`);
    expect(JSON.parse(patch[1].body as string)).toEqual({
      active: true,
      events: ["pull_request", "pull_request_review", "push"],
      config: { url: hook.url, content_type: "json", secret: hook.secret, insecure_ssl: "0" },
    });
  });

  /** Una pagina di hook con l'header Link verso `next` (o senza, se ultima). */
  function hookPage(items: unknown[], next: string | null): Response {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (next) headers["link"] = `<${next}>; rel="next", <${next}>; rel="last"`;
    return new Response(JSON.stringify(items), { status: 200, headers });
  }
  const PAGE2_URL = `${LIST_URL}?per_page=100&page=2`;
  const otherHook = (id: number) => ({ id, config: { url: `https://altro.example.com/hook/${id}` } });

  it("hook esistente in SECONDA pagina: PATCH su quello, nessun POST (nessun duplicato)", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") {
        return Promise.resolve(hookPage([otherHook(1), otherHook(2)], PAGE2_URL));
      }
      if (url === PAGE2_URL && method === "GET") {
        return Promise.resolve(hookPage([otherHook(3), { id: 7, config: { url: hook.url } }], null));
      }
      if (url === `${LIST_URL}/7` && method === "PATCH") {
        return Promise.resolve(jsonResponse({ id: 7, config: { url: hook.url } }, 200));
      }
      // Il duplicato riceverebbe una risposta valida: deve fallire
      // l'asserzione "nessun POST", non il doppio.
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ id: 99, config: { url: hook.url } }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.ensureWebhook(config, hook);

    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    const patches = fetchImpl.mock.calls.filter((c) => c[1]?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]![0]).toBe(`${LIST_URL}/7`);
    expect(result).toMatchObject({ created: false, updated: true, id: "7" });
  });

  it("nessun hook in nessuna pagina: legge tutte le pagine e fa UN solo POST", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") return Promise.resolve(hookPage([otherHook(1)], PAGE2_URL));
      if (url === PAGE2_URL && method === "GET") return Promise.resolve(hookPage([otherHook(2)], null));
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ id: 42, config: { url: hook.url } }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.ensureWebhook(config, hook);

    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toContain(PAGE2_URL);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    expect(result).toMatchObject({ created: true, updated: false, id: "42" });
  });

  it("Link next verso un host estraneo: GitProviderError, nessuna richiesta lì e nessun POST", async () => {
    const evil = "https://evil.example.com/repos/octo/repo/hooks?page=2";
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") return Promise.resolve(hookPage([otherHook(1)], evil));
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ id: 99, config: { url: hook.url } }, 201));
      }
      return Promise.resolve(jsonResponse([{ id: 7, config: { url: hook.url } }], 200));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(config, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/host inatteso/);
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith("https://evil.example.com"))).toBe(false);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("tetto di pagine superato: GitProviderError e nessun POST", async () => {
    // Ogni pagina rimanda alla successiva, all'infinito, senza mai l'hook.
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST") return Promise.resolve(jsonResponse({ id: 99, config: { url: hook.url } }, 201));
      const n = Number(new URL(url).searchParams.get("page") ?? "1");
      return Promise.resolve(hookPage([otherHook(n)], `${LIST_URL}?per_page=100&page=${n + 1}`));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(config, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/pagine di webhook/);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    expect(fetchImpl.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "GET")).toHaveLength(5);
  });

  it("lista dalla forma inattesa: GitProviderError e nessun POST", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return Promise.resolve(jsonResponse({ id: 99, config: { url: hook.url } }, 201));
      return Promise.resolve(jsonResponse({ message: "not a list" }, 200));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(config, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("403: GitProviderError con guida sui permessi webhook", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 })));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(config, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/webhook|admin:repo_hook/i);
  });

  it("errore di rete: lanciato come GitProviderError", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const provider = new GitHubProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(config, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/network down/);
  });
});

describe("GitHubProvider.verifyWebhook", () => {
  const provider = new GitHubProvider();
  const secret = "shh-github";
  const rawBody = JSON.stringify({ hello: "world" });
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts a valid X-Hub-Signature-256 HMAC", () => {
    expect(provider.verifyWebhook({ "x-hub-signature-256": signature }, rawBody, secret)).toBe(true);
    expect(provider.verifyWebhook({ "X-Hub-Signature-256": signature }, rawBody, secret)).toBe(true);
  });

  it("verifies against the raw body as Buffer too", () => {
    expect(provider.verifyWebhook({ "x-hub-signature-256": signature }, Buffer.from(rawBody), secret)).toBe(
      true
    );
  });

  it("rejects an invalid signature", () => {
    expect(provider.verifyWebhook({ "x-hub-signature-256": signature }, rawBody + "x", secret)).toBe(false);
    expect(provider.verifyWebhook({ "x-hub-signature-256": "sha256=00" }, rawBody, secret)).toBe(false);
    expect(provider.verifyWebhook({ "x-hub-signature-256": "nonsense" }, rawBody, secret)).toBe(false);
  });

  it("rejects when the header is missing", () => {
    expect(provider.verifyWebhook({}, rawBody, secret)).toBe(false);
  });
});

const credentials: AccountCredentials = { provider: "github", credentials: { token: "ghp_secret" } };
const account = { credentials };

function repoPage(repos: { full_name: string; name: string; clone_url: string; default_branch: string }[]): Response {
  return new Response(JSON.stringify(repos), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHubProvider.listRepositories", () => {
  it("maps fields, uses Bearer auth + github Accept header and the affiliation query", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      repoPage([
        {
          full_name: "octo/repo-a",
          name: "repo-a",
          clone_url: "https://github.com/octo/repo-a.git",
          default_branch: "main",
        },
        {
          full_name: "octo/repo-b",
          name: "repo-b",
          clone_url: "https://github.com/octo/repo-b.git",
          default_branch: "develop",
        },
      ]),
    );
    const provider = new GitHubProvider({ fetchImpl });

    const repos = await provider.listRepositories(account);

    expect(repos).toEqual([
      { fullName: "octo/repo-a", name: "repo-a", cloneUrl: "https://github.com/octo/repo-a.git", defaultBranch: "main" },
      { fullName: "octo/repo-b", name: "repo-b", cloneUrl: "https://github.com/octo/repo-b.git", defaultBranch: "develop" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.github.com/user/repos");
    expect(url).toContain("per_page=100");
    expect(url).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
  });

  it("follows the Link header for pagination but caps at ~300 repos", async () => {
    // Each page returns 100 repos AND a `next` Link, so without the cap it
    // would loop forever; the cap stops at 3 pages.
    let page = 0;
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      page++;
      const repos = Array.from({ length: 100 }, (_, i) => ({
        full_name: `octo/r-${page}-${i}`,
        name: `r-${page}-${i}`,
        clone_url: `https://github.com/octo/r-${page}-${i}.git`,
        default_branch: "main",
      }));
      const next = `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"`;
      void url;
      return Promise.resolve(
        new Response(JSON.stringify(repos), {
          status: 200,
          headers: { "content-type": "application/json", link: next },
        }),
      );
    });
    const provider = new GitHubProvider({ fetchImpl });

    const repos = await provider.listRepositories(account);
    expect(repos).toHaveLength(300);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("401 → GitProviderError in italiano", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad creds", { status: 401 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/autenticazione|401/i);
  });
});

describe("GitHubProvider.listBranches", () => {
  it("returns the default branch from the repo and the branch names", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === "https://api.github.com/repos/octo/repo") {
        return Promise.resolve(
          new Response(JSON.stringify({ default_branch: "main" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("https://api.github.com/repos/octo/repo/branches")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ name: "main" }, { name: "develop" }, { name: "feature/x" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.listBranches(credentials, "octo/repo");
    expect(result.defaultBranch).toBe("main");
    expect(result.branches).toEqual(["main", "develop", "feature/x"]);
    const branchCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("/branches"))!;
    expect((branchCall[1] as RequestInit).headers as Record<string, string>).toMatchObject({
      Authorization: "Bearer ghp_secret",
    });
  });

  it("caps branches at ~200 via pagination", async () => {
    let page = 0;
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === "https://api.github.com/repos/octo/repo") {
        return Promise.resolve(
          new Response(JSON.stringify({ default_branch: "main" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      page++;
      const branches = Array.from({ length: 100 }, (_, i) => ({ name: `b-${page}-${i}` }));
      const next = `<https://api.github.com/repos/octo/repo/branches?page=${page + 1}>; rel="next"`;
      return Promise.resolve(
        new Response(JSON.stringify(branches), {
          status: 200,
          headers: { "content-type": "application/json", link: next },
        }),
      );
    });
    const provider = new GitHubProvider({ fetchImpl });
    const result = await provider.listBranches(credentials, "octo/repo");
    expect(result.branches).toHaveLength(200);
  });

  it("401 → GitProviderError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.listBranches(credentials, "octo/repo")).rejects.toBeInstanceOf(GitProviderError);
  });
});

describe("GitHubProvider: un Link next fuori da api.github.com non viene seguito", () => {
  // Il Link `next` lo scrive la risposta: se puntasse altrove, seguirlo
  // consegnerebbe il Bearer token a un host scelto da quella risposta.
  const EVIL = "https://api.github.com@evil.example/user/repos?page=2";

  function fetchWith(firstPage: (url: string) => { body: unknown; next?: string }) {
    return vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      const { body, next } = url.startsWith("https://api.github.com/") ? firstPage(url) : { body: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", ...(next ? { link: `<${next}>; rel="next"` } : {}) },
        })
      );
    });
  }

  function expectBlocked(error: unknown, fetchImpl: ReturnType<typeof vi.fn>) {
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/host inatteso/);
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
    const calledUrls = fetchImpl.mock.calls.map((c) => String((c as [string])[0]));
    expect(calledUrls).not.toContain(EVIL);
    expect(calledUrls.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
  }

  it("listRepositories", async () => {
    const fetchImpl = fetchWith(() => ({
      body: [{ full_name: "octo/a", name: "a", clone_url: "https://github.com/octo/a.git", default_branch: "main" }],
      next: EVIL,
    }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.listRepositories(account).then(() => null, (e: unknown) => e);
    expectBlocked(error, fetchImpl);
  });

  it("listBranches", async () => {
    const fetchImpl = fetchWith((url) =>
      url.includes("/branches") ? { body: [{ name: "main" }], next: EVIL } : { body: { default_branch: "main" } }
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.listBranches(credentials, "octo/repo").then(() => null, (e: unknown) => e);
    expectBlocked(error, fetchImpl);
  });

  it("listPrComments (tutte e tre le fonti)", async () => {
    for (const source of ["/issues/", "/pulls/42/comments", "/reviews"]) {
      const fetchImpl = fetchWith((url) => (url.includes(source) ? { body: [], next: EVIL } : { body: [] }));
      const provider = new GitHubProvider({ fetchImpl });
      const error = await provider.listPrComments(config, 42).then(() => null, (e: unknown) => e);
      expectBlocked(error, fetchImpl);
    }
  });
});

describe("GitHubProvider.setCommitStatus", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("POST con state, context = key, descrizione e target_url; refname ignorato", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 201));
    const provider = new GitHubProvider({ fetchImpl });

    await provider.setCommitStatus(config, SHA, {
      state: "success",
      key: "stubwise-review",
      description: "Approvata dalla review",
      url: "https://stubwise.example.com/tickets/t1",
      refname: "stubwise/ticket-7",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/octo/repo/statuses/${SHA}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_secret");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(JSON.parse(init.body as string)).toEqual({
      state: "success",
      context: "stubwise-review",
      description: "Approvata dalla review",
      target_url: "https://stubwise.example.com/tickets/t1",
    });
  });

  it("senza url niente target_url; descrizione oltre 140 caratteri troncata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 201));
    const provider = new GitHubProvider({ fetchImpl });
    await provider.setCommitStatus(config, SHA, {
      state: "pending",
      key: "stubwise-review",
      description: "x".repeat(200),
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("target_url");
    expect(body.state).toBe("pending");
    expect(body.description).toHaveLength(140);
    expect(body.description.endsWith("…")).toBe(true);
  });

  it("descrizione di esattamente 140 caratteri: intatta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 201));
    const provider = new GitHubProvider({ fetchImpl });
    const description = "y".repeat(140);
    await provider.setCommitStatus(config, SHA, { state: "failure", key: "stubwise-review", description });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.state).toBe("failure");
    expect(body.description).toBe(description);
  });

  it("sha abbreviato → GitProviderError, nessuna richiesta", async () => {
    // Il doppio risponde comunque con una Response valida: se il controllo
    // sullo sha sparisse, la chiamata andrebbe a buon fine e il test cadrebbe
    // sull'asserzione, non su un TypeError del doppio.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: 1 }, 201)));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(
      provider.setCommitStatus(config, "abc123", { state: "pending", key: "stubwise-review", description: "d" })
    ).rejects.toBeInstanceOf(GitProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non-2xx → GitProviderError con lo status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 422 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .setCommitStatus(config, SHA, { state: "pending", key: "stubwise-review", description: "d" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(422);
    expect((error as GitProviderError).message).not.toContain("Commit statuses write");
  });

  it("403 → GitProviderError che dice quale permesso manca, senza il token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .setCommitStatus(config, SHA, { state: "success", key: "stubwise-review", description: "d" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    expect((error as GitProviderError).message).toContain(
      "il token deve poter scrivere gli status di commit (GitHub: Commit statuses write; Bitbucket: repository write)"
    );
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
  });
});

describe("GitHubProvider.submitPrReview", () => {
  const REVIEWS_URL = "https://api.github.com/repos/octo/repo/pulls/42/reviews";
  const HINT =
    "il token deve poter revisionare le pull request (GitHub: Pull requests write; Bitbucket: pullrequest write)";

  it("request_changes → una review REQUEST_CHANGES col testo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1, state: "CHANGES_REQUESTED" }, 200));
    const provider = new GitHubProvider({ fetchImpl });

    const outcome = await provider.submitPrReview(config, 42, "request_changes", "Manca il test");

    // GitHub non ha un «già in quello stato»: ogni review è nuova.
    expect(outcome).toEqual({ status: "submitted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REVIEWS_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/vnd.github+json");
    expect(JSON.parse(init.body as string)).toEqual({ event: "REQUEST_CHANGES", body: "Manca il test" });
  });

  it("approve col testo → APPROVE col testo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1, state: "APPROVED" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await provider.submitPrReview(config, 42, "approve", "Tutto a posto");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE", body: "Tutto a posto" });
  });

  it("approve con corpo vuoto → APPROVE senza body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1, state: "APPROVED" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await provider.submitPrReview(config, 42, "approve", "");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE" });
  });

  it("opts.fetchImpl per chiamata vince su quello del costruttore", async () => {
    const ctorFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 200));
    const callFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 200));
    const provider = new GitHubProvider({ fetchImpl: ctorFetch });
    await provider.submitPrReview(config, 42, "approve", "ok", { fetchImpl: callFetch });
    expect(callFetch).toHaveBeenCalledTimes(1);
    expect(ctorFetch).not.toHaveBeenCalled();
  });

  it("422 → GitProviderError che nomina il caso dell'autore della PR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Unprocessable Entity", errors: ["Can not approve your Own Pull Request"] }), {
        status: 422,
      })
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "approve", "ok")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(422);
    expect((error as GitProviderError).message).toMatch(/non permette all'autore della PR/);
    expect((error as GitProviderError).message).not.toMatch(/possibile/);
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
    expect((error as GitProviderError).responseText).toMatch(/own pull request/i);
  });

  it("422 con un'altra causa → estratto della risposta (max 200), autore solo come causa possibile", async () => {
    const detail = "Validation Failed: pull request is closed " + "x".repeat(400);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: detail }), { status: 422 })
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "approve", "ok")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(422);
    const message = (error as GitProviderError).message;
    expect(message).toContain("pull request is closed");
    expect(message).toMatch(/possibile/);
    expect(message).not.toMatch(/non permette all'autore/);
    expect(message).not.toContain("x".repeat(201));
    expect(message).not.toContain("ghp_secret");
  });

  it("422 con il token nel corpo → mascherato (***) nel messaggio e in responseText, anche oltre il taglio", async () => {
    // Per ipotesi: GitHub non ha motivo di rimandare il token, ma il corpo non
    // è sotto il nostro controllo e il messaggio finisce nei log. La seconda
    // occorrenza sta a cavallo del taglio a 200 caratteri: mascherare DOPO il
    // taglio ne lascerebbe passare un pezzo.
    const detail = `Validation Failed: ghp_secret ${"y".repeat(152)}ghp_secret tail`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: detail }), { status: 422 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "approve", "ok")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    const { message, responseText } = error as GitProviderError;
    expect(message).toContain("Validation Failed: ***");
    expect(message).not.toContain("ghp_secret");
    expect(message).not.toContain("ghp_");
    expect(responseText).not.toContain("ghp_secret");
    expect(responseText).toContain("***");
  });

  it("request_changes con testo di soli spazi → errore locale, nessuna chiamata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "request_changes", "   ")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/REQUEST_CHANGES richiede un testo/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("approve con testo di soli spazi → APPROVE senza body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1, state: "APPROVED" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await provider.submitPrReview(config, 42, "approve", "   ");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE" });
  });

  it("403 → il messaggio dice quale permesso manca, senza credenziali", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "approve", "ok")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    expect((error as GitProviderError).message).toContain(HINT);
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
  });

  it("altri non-2xx (500) → GitProviderError generico, senza il suggerimento sui permessi", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .submitPrReview(config, 42, "request_changes", "Manca il test")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(500);
    expect((error as GitProviderError).message).not.toContain(HINT);
    expect((error as GitProviderError).message).not.toMatch(/autore/);
  });
});

describe("GitHubProvider.getAuthenticatedUserId", () => {
  const USER_URL = "https://api.github.com/user";

  it("GET /user con Bearer → id numerico come stringa", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 12345, login: "stubwise-bot" }, 200));
    const provider = new GitHubProvider({ fetchImpl });

    await expect(provider.getAuthenticatedUserId({ credentials: { token: "ghp_secret" } })).resolves.toBe("12345");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(USER_URL);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/vnd.github+json");
  });

  it("restituisce l'id, MAI il login", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 987, login: "1234" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).resolves.toBe("987");
  });

  it("accetta anche una ProjectGitConfig intera", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 7, login: "x" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).resolves.toBe("7");
  });

  it("opts.fetchImpl per chiamata vince su quello del costruttore", async () => {
    const ctorFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 1, login: "ctor" }, 200));
    const callFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 2, login: "call" }, 200));
    const provider = new GitHubProvider({ fetchImpl: ctorFetch });
    await expect(provider.getAuthenticatedUserId(config, { fetchImpl: callFetch })).resolves.toBe("2");
    expect(ctorFetch).not.toHaveBeenCalled();
  });

  it("stessa fixture utente: === actorId del webhook === authorId dei commenti", async () => {
    // Il confronto del design §5 è un'uguaglianza di stringhe: la forma
    // dell'identità deve essere UNA sola nei tre punti.
    const user = { id: 424242, login: "stubwise-bot", type: "User" };
    const fetchImpl = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url === USER_URL) return Promise.resolve(jsonResponse({ ...user }, 200));
      if (url.includes("/issues/42/comments")) {
        return Promise.resolve(
          jsonResponse(
            [{ id: 1, user: { ...user }, body: "da correggere", created_at: "2026-09-30T10:01:00Z" }],
            200
          )
        );
      }
      return Promise.resolve(jsonResponse([], 200));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const me = await provider.getAuthenticatedUserId(config);
    const [fromComment] = await provider.listPrComments(config, 42);
    const fromEvent = provider.parseChangesRequestedEvent(
      { "x-github-event": "pull_request_review" },
      {
        action: "submitted",
        review: { id: 900, state: "changes_requested", body: "no", user: { ...user } },
        pull_request: { number: 42, head: { ref: "stubwise/ticket-7" } },
        sender: { ...user },
      }
    );

    expect(me).toBe("424242");
    expect(fromEvent?.actorId).toBe(me);
    expect(fromComment?.authorId).toBe(me);
  });

  it.each([
    ["id stringa", { id: "12345", login: "x" }],
    ["id assente", { login: "x" }],
    ["id non intero", { id: 1.5, login: "x" }],
    ["id oltre gli interi sicuri", { id: 2 ** 53, login: "x" }],
    ["corpo null", null],
  ])("risposta con %s → GitProviderError (mai un'identità inventata)", async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).rejects.toBeInstanceOf(GitProviderError);
  });

  it("401 → GitProviderError che dice credenziali non valide, senza il token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 401 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(401);
    const message = (error as GitProviderError).message;
    expect(message).toMatch(/credenziali/i);
    expect(message).not.toMatch(/GitHub App/);
    expect(message).not.toContain("ghp_secret");
  });

  it("403 → GitProviderError che spiega che serve un utente/PAT e non una GitHub App, senza il token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    const message = (error as GitProviderError).message;
    expect(message).toMatch(/GitHub App/);
    expect(message).toMatch(/personal access token/i);
    expect(message).not.toMatch(/credenziali non valide/i);
    expect(message).not.toContain("ghp_secret");
  });

  it.each([401, 403])("%i con il token nel corpo → il messaggio non lo riporta", async (status) => {
    // I test sopra usano corpi senza il token, dove "non contiene" è vero per
    // costruzione: qui il corpo lo contiene, e il messaggio non deve citarlo.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials: ghp_secret" }), { status })
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(status);
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
  });

  it("403 da rate limit (header) → messaggio sul rate limit, non sulla GitHub App", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("forbidden", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    const message = (error as GitProviderError).message;
    expect(message).toMatch(/rate limit/i);
    expect(message).not.toMatch(/GitHub App/);
    expect(message).not.toContain("ghp_secret");
  });

  it("403 da rate limit (corpo, maiuscole indifferenti) → messaggio sul rate limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "API Rate Limit exceeded for user ID 1." }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "12" },
      })
    );
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    const message = (error as GitProviderError).message;
    expect(message).toMatch(/rate limit/i);
    expect(message).not.toMatch(/GitHub App/);
  });

  it("altri non-2xx → GitProviderError con lo status vero, anche con un'identità nel corpo", async () => {
    // Corpo JSON VALIDO con un id: se il controllo dello status mancasse, la
    // risposta verrebbe letta come un'identità buona.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 12345, login: "x" }, 500));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(500);
    expect((error as GitProviderError).message).not.toMatch(/GitHub App/);
  });
});

describe("GitHubProvider.getCollaboratorPermission", () => {
  const PERM_URL = "https://api.github.com/repos/octo/repo/collaborators/mario-rossi/permission";

  it.each([
    ["admin", "admin"],
    ["maintain", "write"],
    ["write", "write"],
    ["triage", "read"],
    ["read", "read"],
  ] as const)("role_name %s (permission legacy %s) → role_name", async (roleName, permission) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: roleName, permission }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).resolves.toBe(roleName);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PERM_URL);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_secret");
  });

  it("role_name di un ruolo personalizzato → ripiego su permission", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: "security-reviewer", permission: "read" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).resolves.toBe("read");
  });

  it("senza role_name → permission", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ permission: "write" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).resolves.toBe("write");
  });

  it("permission none → none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: "none", permission: "none" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).resolves.toBe("none");
  });

  it("nessun ruolo riconoscibile → lancia, MAI un permesso inventato", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: "boh", permission: "boh" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).rejects.toBeInstanceOf(GitProviderError);
  });

  it("404 (non collaboratore) → none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).resolves.toBe("none");
  });

  it("403 → GitProviderError che nomina il permesso mancante, senza token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"Resource not accessible by personal access token ghp_secret"}', { status: 403 }));
    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider
      .getCollaboratorPermission(config, "mario-rossi")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    expect((error as GitProviderError).message).toContain("Metadata");
    expect((error as GitProviderError).message).not.toContain("ghp_secret");
    expect((error as GitProviderError).responseText).not.toContain("ghp_secret");
  });

  it("403 da rate limit → messaggio suo, non il permesso mancante", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
    );
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).rejects.toThrow(/rate limit/);
  });

  it("401 → GitProviderError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).rejects.toMatchObject({ status: 401 });
  });

  it("500 → GitProviderError, mai none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario-rossi")).rejects.toMatchObject({ status: 500 });
  });

  it.each(["../../admin", "mario/rossi", "mario?x=1", "", "-mario", "_mario", "mario rossi", "a".repeat(46), "mario%2F", "mario.rossi"])(
    "login malformato %j → lancia SENZA fare la richiesta",
    async (login) => {
      // Il doppio risponderebbe comunque "admin": se la richiesta partisse, il
      // test lo vedrebbe dal risultato e dal conteggio.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: "admin", permission: "admin" }, 200));
      const provider = new GitHubProvider({ fetchImpl });
      await expect(provider.getCollaboratorPermission(config, login)).rejects.toBeInstanceOf(GitProviderError);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("login Enterprise Managed User (`handle_shortcode`) → ammesso, URL composto", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ role_name: "write", permission: "write" }, 200));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "mario_acme")).resolves.toBe("write");
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/octo/repo/collaborators/mario_acme/permission"
    );
  });

  it("login di una GitHub App (`[bot]`) → ammesso e codificato nell'URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getCollaboratorPermission(config, "dependabot[bot]")).resolves.toBe("none");
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/octo/repo/collaborators/dependabot%5Bbot%5D/permission"
    );
  });
});

/** Un fetch che non risponde mai: si ferma solo se la richiesta viene interrotta. */
function hangingFetch() {
  return vi.fn(
    (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("richiesta interrotta (timeout)")));
      })
  );
}

describe("GitHubProvider — ciclo di correzione: scopo dei controlli e tempi massimi (1 ott 2026)", () => {
  it("validateCredentials dichiara lo scopo di ogni controllo: push, rest, webhook", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("info/refs")) return Promise.resolve(new Response("", { status: 200 }));
      if (url.endsWith("/hooks?per_page=1")) return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(jsonResponse({ permissions: { push: true } }, 200));
    });
    const checks = await new GitHubProvider().validateCredentials(config, { fetchImpl });

    expect(checks.map((c) => [c.purpose, c.ok])).toEqual([
      ["push", true],
      ["rest", true],
      ["webhook", false],
    ]);
  });

  it("getAuthenticatedUserId: un provider che non risponde diventa un errore, non un'attesa senza limite", async () => {
    const fetchImpl = hangingFetch();
    const provider = new GitHubProvider({ fetchImpl });

    await expect(provider.getAuthenticatedUserId(config, { timeoutMs: 20 })).rejects.toThrow(/timeout/);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("getCollaboratorPermission: un provider che non risponde diventa un errore", async () => {
    const fetchImpl = hangingFetch();
    const provider = new GitHubProvider({ fetchImpl });

    await expect(provider.getCollaboratorPermission(config, "mario-rossi", { timeoutMs: 20 })).rejects.toThrow(
      /timeout/
    );
  });
});

describe("GitHubProvider — i metodi del ciclo hanno un tempo massimo (1 ott 2026)", () => {
  it("setCommitStatus: un provider che non risponde diventa un errore dopo il timeout di default", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GitHubProvider({ fetchImpl: hangingFetch() });
      const pending = provider.setCommitStatus(config, "0123456789abcdef0123456789abcdef01234567", {
        state: "pending",
        key: "stubwise-review",
        description: "d",
      });
      const outcome = expect(pending).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
