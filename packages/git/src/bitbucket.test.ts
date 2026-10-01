import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import {
  BITBUCKET_PRIMARY_SCOPES,
  BITBUCKET_REVIEWER_SCOPES,
  bitbucketRequiredScopes,
  parseBitbucketScopes,
} from "./bitbucket-scopes.js";
import {
  GitProviderError,
  MergeNotAllowedError,
  ReviewCommentFailedError,
  type AccountCredentials,
  type ProjectGitConfig,
} from "./provider.js";

const config: ProjectGitConfig = {
  repoUrl: "https://bitbucket.org/myws/myrepo",
  defaultBranch: "main",
  credentials: { username: "alice", token: "app-pass" },
};

const prResponseBody = {
  links: { html: { href: "https://bitbucket.org/myws/myrepo/pull-requests/7" } },
};

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("BitbucketProvider.getCloneUrl", () => {
  const provider = new BitbucketProvider();

  it("embeds username and app password in the https clone URL", () => {
    expect(provider.getCloneUrl(config)).toBe("https://alice:app-pass@bitbucket.org/myws/myrepo.git");
  });

  it("handles trailing .git and trailing slash in repoUrl", () => {
    expect(provider.getCloneUrl({ ...config, repoUrl: "https://bitbucket.org/myws/myrepo.git" })).toBe(
      "https://alice:app-pass@bitbucket.org/myws/myrepo.git"
    );
    expect(provider.getCloneUrl({ ...config, repoUrl: "https://bitbucket.org/myws/myrepo/" })).toBe(
      "https://alice:app-pass@bitbucket.org/myws/myrepo.git"
    );
  });

  it("percent-encodes credentials", () => {
    const url = provider.getCloneUrl({
      ...config,
      credentials: { username: "a@b", token: "p:ss/w" },
    });
    expect(url).toBe("https://a%40b:p%3Ass%2Fw@bitbucket.org/myws/myrepo.git");
  });

  it("throws when username is missing (required for app passwords)", () => {
    expect(() => provider.getCloneUrl({ ...config, credentials: { token: "app-pass" } })).toThrow(/username/i);
  });

  it("throws a clear error on unparsable repoUrl", () => {
    expect(() => provider.getCloneUrl({ ...config, repoUrl: "https://bitbucket.org/onlyws" })).toThrow(
      /repo url/i
    );
    expect(() => provider.getCloneUrl({ ...config, repoUrl: "not a url" })).toThrow(/repo url/i);
  });
});

describe("BitbucketProvider.getAuthHeader", () => {
  const provider = new BitbucketProvider();

  it("returns Basic auth with username:app-password", () => {
    // base64("alice:app-pass")
    expect(provider.getAuthHeader(config)).toBe("Basic YWxpY2U6YXBwLXBhc3M=");
  });

  it("encodes the raw credentials verbatim (no percent-encoding before base64)", () => {
    expect(provider.getAuthHeader({ ...config, credentials: { username: "a@b", token: "p:ss/w" } })).toBe(
      `Basic ${Buffer.from("a@b:p:ss/w").toString("base64")}`
    );
  });

  it("throws when username is missing (required for app passwords)", () => {
    expect(() => provider.getAuthHeader({ ...config, credentials: { token: "app-pass" } })).toThrow(
      /username/i
    );
  });
});

describe("BitbucketProvider.openPullRequest", () => {
  it("POSTs to the Bitbucket API with Basic auth and the correct body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(prResponseBody));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.openPullRequest(config, {
      branch: "stubwise/fix-1",
      title: "Fix the bug",
      body: "Closes #1",
    });

    expect(result).toEqual({ url: "https://bitbucket.org/myws/myrepo/pull-requests/7" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice:app-pass").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Fix the bug",
      description: "Closes #1",
      source: { branch: { name: "stubwise/fix-1" } },
      destination: { branch: { name: "main" } },
    });
  });

  it("uses the Atlassian email (not the username) for Basic auth when email is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(prResponseBody));
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.openPullRequest(
      { ...config, credentials: { username: "alice", email: "alice@corp.io", token: "api-token" } },
      { branch: "b", title: "t", body: "b" }
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // base64("alice@corp.io:api-token") — the email, NOT the username.
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("falls back to username for Basic auth when email is absent (legacy app passwords)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(prResponseBody));
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.openPullRequest(config, { branch: "b", title: "t", body: "b" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice:app-pass").toString("base64")}`);
  });

  it("throws when both email and username are missing (before any request)", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(
      provider.openPullRequest(
        { ...config, credentials: { token: "t" } },
        { branch: "b", title: "t", body: "b" }
      )
    ).rejects.toThrow(/email.*username|username.*email/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws GitProviderError with status and truncated response text on non-2xx", async () => {
    const longText = "x".repeat(600);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(longText, { status: 400 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .openPullRequest(config, { branch: "b", title: "t", body: "b" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    const gpError = error as GitProviderError;
    expect(gpError.status).toBe(400);
    expect(gpError.responseText).toBe("x".repeat(500));
    expect(gpError.message).toContain("400");
  });

  it("throws GitProviderError when a 2xx response is missing links.html.href", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 7 }, 200));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .openPullRequest(config, { branch: "b", title: "t", body: "b" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    const gpError = error as GitProviderError;
    expect(gpError.status).toBe(200);
    expect(gpError.message).toMatch(/links\.html\.href/);
  });

  it("throws GitProviderError when a 2xx response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const provider = new BitbucketProvider({ fetchImpl });

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

describe("BitbucketProvider.getPullRequestState", () => {
  it("state=OPEN → 'open'; MERGED/DECLINED/SUPERSEDED → 'closed'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state: "OPEN" }, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.getPullRequestState(config, 7)).resolves.toBe("open");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7",
      expect.objectContaining({ method: "GET" })
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice:app-pass").toString("base64")}`);

    for (const state of ["MERGED", "DECLINED", "SUPERSEDED"]) {
      const closedFetch = vi.fn().mockResolvedValue(jsonResponse({ state }, 200));
      const closedProvider = new BitbucketProvider({ fetchImpl: closedFetch });
      await expect(closedProvider.getPullRequestState(config, 7)).resolves.toBe("closed");
    }
  });

  it("uses the Atlassian email (not the username) for Basic auth when email is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state: "OPEN" }, 200));
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.getPullRequestState(
      { ...config, credentials: { username: "alice", email: "alice@corp.io", token: "api-token" } },
      7
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("throws GitProviderError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .getPullRequestState(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(404);
  });
});

describe("BitbucketProvider.getPullRequestFinalState", () => {
  async function stateOf(state: unknown): Promise<unknown> {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state }, 200));
    return new BitbucketProvider({ fetchImpl })
      .getPullRequestFinalState(config, 7)
      .catch((e: unknown) => e);
  }

  it("OPEN → open; MERGED → merged; DECLINED/SUPERSEDED → closed_unmerged", async () => {
    expect(await stateOf("OPEN")).toBe("open");
    expect(await stateOf("MERGED")).toBe("merged");
    expect(await stateOf("DECLINED")).toBe("closed_unmerged");
    expect(await stateOf("SUPERSEDED")).toBe("closed_unmerged");
  });

  it("uno stato sconosciuto o assente lancia: non si deduce", async () => {
    expect(await stateOf("WHATEVER")).toBeInstanceOf(GitProviderError);
    expect(await stateOf(undefined)).toBeInstanceOf(GitProviderError);
  });

  it("404 → GitProviderError con lo status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const error = await new BitbucketProvider({ fetchImpl })
      .getPullRequestFinalState(config, 7)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(404);
  });
});

describe("BitbucketProvider.getPullRequestChecks", () => {
  /** PR risolta con successo (source.commit.hash) prima della lettura degli statuses. */
  function prResponse(headSha = "abc123", branchName?: string): Response {
    return jsonResponse(
      { source: { commit: { hash: headSha }, ...(branchName ? { branch: { name: branchName } } : {}) } },
      200
    );
  }

  function fetchSequence(pr: Response, statuses: Response) {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(pr).mockResolvedValueOnce(statuses);
    return fetchImpl;
  }

  it("tutti verdi → status success, con headSha risolto dalla PR", async () => {
    const fetchImpl = fetchSequence(
      prResponse(),
      jsonResponse(
        {
          values: [
            { key: "build", name: "build", state: "SUCCESSFUL" },
            { key: "test", name: "test", state: "SUCCESSFUL" },
          ],
        },
        200
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);

    expect(result).toEqual({
      status: "success",
      checks: [
        { name: "build", status: "success" },
        { name: "test", status: "success" },
      ],
      headSha: "abc123",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7/statuses?pagelen=100",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("uno FAILED → status failure", async () => {
    const fetchImpl = fetchSequence(
      prResponse(),
      jsonResponse(
        {
          values: [
            { key: "build", name: "build", state: "SUCCESSFUL" },
            { key: "test", name: "test", state: "FAILED" },
          ],
        },
        200
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result.status).toBe("failure");
  });

  it("INPROGRESS → status pending", async () => {
    const fetchImpl = fetchSequence(
      prResponse(),
      jsonResponse({ values: [{ key: "build", name: "build", state: "INPROGRESS" }] }, 200)
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result).toEqual({
      status: "pending",
      checks: [{ name: "build", status: "pending" }],
      headSha: "abc123",
    });
  });

  it("nessun check configurato → 'no_checks', DIVERSO da 'failure' e da 'unknown'", async () => {
    const fetchImpl = fetchSequence(prResponse(), jsonResponse({ values: [] }, 200));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result).toEqual({ status: "no_checks", checks: [], headSha: "abc123" });
  });

  it("errore di rete: non lancia, ricade su 'unknown' — DIVERSO da 'no_checks' (review fix Task 2)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result).toEqual({ status: "unknown", checks: [] });
  });

  it("non-2xx sul fetch della PR: non lancia, ricade su 'unknown', senza headSha", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result).toEqual({ status: "unknown", checks: [] });
  });

  it("non-2xx sul fetch degli statuses (PR già risolta): 'unknown' CON headSha", async () => {
    const fetchImpl = fetchSequence(prResponse(), new Response("nope", { status: 500 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result).toEqual({ status: "unknown", checks: [], headSha: "abc123" });
  });

  it("source.branch.name della PR → headRef (review fix Task 1, etichetta della coda per le PR esterne)", async () => {
    const fetchImpl = fetchSequence(
      prResponse("abc123", "fix/typo-in-readme"),
      jsonResponse({ values: [] }, 200)
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);
    expect(result.headRef).toBe("fix/typo-in-readme");
  });

  it("lo status `stubwise-review` non è un check: la coda di rilascio ha già il verdetto della review", async () => {
    const fetchImpl = fetchSequence(
      prResponse(),
      jsonResponse(
        {
          values: [
            { key: "build", name: "build", state: "SUCCESSFUL" },
            { key: "stubwise-review", name: "Stubwise review", state: "FAILED" },
          ],
        },
        200
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);

    expect(result).toEqual({
      status: "success",
      checks: [{ name: "build", status: "success" }],
      headSha: "abc123",
    });
  });

  it("se `stubwise-review` è l'unico status, la PR non ha check", async () => {
    const fetchImpl = fetchSequence(
      prResponse(),
      jsonResponse({ values: [{ key: "stubwise-review", name: "Stubwise review", state: "INPROGRESS" }] }, 200)
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.getPullRequestChecks(config, 7);

    expect(result).toEqual({ status: "no_checks", checks: [], headSha: "abc123" });
  });
});

describe("BitbucketProvider.mergePullRequest", () => {
  it("POST .../merge con merge_strategy: 'merge_commit' → { merged: true, sha }", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ merge_commit: { hash: "deadbeef" } }, 200));
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.mergePullRequest(config, 7);

    expect(result).toEqual({ merged: true, sha: "deadbeef" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7/merge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ merge_strategy: "merge_commit" });
  });

  it.each([400, 409])("%i → MergeNotAllowedError con reason 'not_mergeable'", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("blocked", { status }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("not_mergeable");
  });

  it.each([403, 404])("%i → MergeNotAllowedError con reason 'forbidden'", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("forbidden");
  });

  it("status non riconosciuto → MergeNotAllowedError con reason 'unknown'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("unknown");
  });

  it("2xx senza merge_commit.hash → MergeNotAllowedError con reason 'unknown'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 200));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .mergePullRequest(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeNotAllowedError);
    expect((error as MergeNotAllowedError).reason).toBe("unknown");
  });
});

describe("BitbucketProvider.createPrComment", () => {
  it("POST di un commento nuovo, senza leggere né modificare quelli esistenti", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 2 }, 201));
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.createPrComment(config, 7, "Analisi");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7/comments",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice:app-pass").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ content: { raw: "Analisi" } });
  });

  it("throws when both email and username are missing (before any request)", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(
      provider.createPrComment({ ...config, credentials: { token: "t" } }, 7, "testo")
    ).rejects.toThrow(/email.*username|username.*email/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws GitProviderError when the create call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .createPrComment(config, 7, "testo")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
  });
});

describe("BitbucketProvider.listPrComments", () => {
  const COMMENTS_URL =
    "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7/comments?pagelen=100";
  const mario = { uuid: "{u-mario}", nickname: "mario.rossi", display_name: "Mario Rossi" };
  const comment = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    created_on: `2026-09-30T10:0${id}:00+00:00`,
    content: { raw: `commento ${id}` },
    user: mario,
    deleted: false,
    ...extra,
  });

  it("generali e inline con file:riga; cancellati, bozze, vuoti e senza autore esclusi", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            values: [
              comment(1),
              comment(2, { inline: { path: "src/a.ts", to: 42, from: null } }),
              comment(3, { inline: { path: "src/b.ts", from: 7 } }),
              comment(4, { deleted: true, content: { raw: "" } }),
              comment(5, { pending: true }),
              comment(6, { content: { raw: "   " } }),
              comment(7, { user: { nickname: "senza-uuid" } }),
            ],
          },
          200
        )
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 7);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(COMMENTS_URL);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice:app-pass").toString("base64")}`
    );
    expect(comments).toEqual([
      {
        id: "1",
        authorId: "{u-mario}",
        authorLogin: "mario.rossi",
        body: "commento 1",
        createdAt: "2026-09-30T10:01:00+00:00",
        path: null,
        line: null,
        authorAssociation: null,
      },
      {
        id: "2",
        authorId: "{u-mario}",
        authorLogin: "mario.rossi",
        body: "commento 2",
        createdAt: "2026-09-30T10:02:00+00:00",
        path: "src/a.ts",
        line: 42,
        authorAssociation: null,
      },
      {
        id: "3",
        authorId: "{u-mario}",
        authorLogin: "mario.rossi",
        body: "commento 3",
        createdAt: "2026-09-30T10:03:00+00:00",
        path: "src/b.ts",
        line: 7,
        // Bitbucket non ha un equivalente di author_association: sempre null
        authorAssociation: null,
      },
    ]);
  });

  it("un cancellato col testo ancora presente è escluso comunque", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ values: [comment(1, { deleted: true })] }, 200))
    );
    const provider = new BitbucketProvider({ fetchImpl });
    expect(await provider.listPrComments(config, 7)).toEqual([]);
  });

  it("stessa fixture utente: authorId del commento === actorId di parseChangesRequestedEvent", async () => {
    // L'identità Bitbucket (uuid grezzo con le graffe, non normalizzato) ha UNA
    // forma sola: il chiamante confronta authorId dei commenti e actorId del
    // webhook con lo stesso `git_accounts.provider_user_id`.
    const user = { type: "user", uuid: "{a1b2c3d4-0000-4000-8000-000000000001}", nickname: "anna.b" };
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ values: [comment(1, { user: { ...user } })] }, 200))
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const [fromComment] = await provider.listPrComments(config, 7);
    const fromEvent = provider.parseChangesRequestedEvent(
      { "x-event-key": "pullrequest:changes_request_created" },
      {
        actor: { ...user },
        pullrequest: { id: 7, source: { branch: { name: "stubwise/ticket-1" } } },
        changes_request: { user: { ...user } },
      }
    );

    expect(fromEvent).not.toBeNull();
    expect(fromComment?.authorId).toBe(fromEvent?.actorId);
    expect(fromComment?.authorLogin).toBe(fromEvent?.actorLogin);
    expect(fromComment?.authorId).toBe(user.uuid);
  });

  it("segue il cursore `next` fino all'ultima pagina", async () => {
    const PAGE_2 = `${COMMENTS_URL}&page=2`;
    const fetchImpl = vi.fn().mockImplementation((input: string | URL) =>
      Promise.resolve(
        String(input) === PAGE_2
          ? jsonResponse({ values: [comment(2)] }, 200)
          : jsonResponse({ values: [comment(1)], next: PAGE_2 }, 200)
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 7);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe(PAGE_2);
    expect(comments.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("un `next` oltre il tetto di 10 pagine → GitProviderError, mai una fotografia a metà", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ values: [comment(1)], next: `${COMMENTS_URL}&page=n` }, 200))
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider.listPrComments(config, 7).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/oltre 10 pagine/);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("esattamente 10 pagine e poi nessun `next` → tutti i commenti, nessun errore", async () => {
    let n = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      n++;
      return Promise.resolve(
        jsonResponse({ values: [comment(1)], ...(n < 10 ? { next: `${COMMENTS_URL}&page=${n + 1}` } : {}) }, 200)
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const comments = await provider.listPrComments(config, 7);

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(comments).toHaveLength(10);
  });

  it("una pagina senza `values` → GitProviderError (risposta inattesa), non \"nessun commento\"", async () => {
    const PAGE_2 = `${COMMENTS_URL}&page=2`;
    const fetchImpl = vi.fn().mockImplementation((input: string | URL) =>
      Promise.resolve(
        String(input) === PAGE_2
          ? jsonResponse({ error: "boh" }, 200)
          : jsonResponse({ values: [comment(1)], next: PAGE_2 }, 200)
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider.listPrComments(config, 7).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/risposta inattesa/);
  });

  it("usa l'email Atlassian come identità REST quando c'è", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ values: [] }, 200)));
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.listPrComments(
      { ...config, credentials: { username: "alice", email: "alice@corp.io", token: "api-token" } },
      7
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("credenziali REST mancanti → lancia prima di qualunque richiesta", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listPrComments({ ...config, credentials: { token: "t" } }, 7)).rejects.toThrow(
      /email.*username|username.*email/i
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("non-2xx → GitProviderError con lo status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider
      .listPrComments(config, 7)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
  });
});

describe("BitbucketProvider.setCommitStatus", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const STATUS_URL = `https://api.bitbucket.org/2.0/repositories/myws/myrepo/commit/${SHA}/statuses/build`;

  it("POST con key, stato mappato, nome, descrizione, url e refname", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ key: "stubwise-review" }, 201));
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.setCommitStatus(config, SHA, {
      state: "failure",
      key: "stubwise-review",
      description: "La review chiede modifiche",
      url: "https://stubwise.example.com/tickets/t1",
      refname: "stubwise/ticket-42",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STATUS_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice:app-pass").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      key: "stubwise-review",
      state: "FAILED",
      name: "Stubwise review",
      description: "La review chiede modifiche",
      url: "https://stubwise.example.com/tickets/t1",
      refname: "stubwise/ticket-42",
    });
  });

  it("pending → INPROGRESS, success → SUCCESSFUL", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, 201)));
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.setCommitStatus(config, SHA, { state: "pending", key: "stubwise-review", description: "d" });
    await provider.setCommitStatus(config, SHA, { state: "success", key: "stubwise-review", description: "d" });
    const states = fetchImpl.mock.calls.map((c) => JSON.parse((c as [string, RequestInit])[1].body as string).state);
    expect(states).toEqual(["INPROGRESS", "SUCCESSFUL"]);
  });

  it("senza url né refname: url = pagina della repository, refname assente", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 201));
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.setCommitStatus(config, SHA, { state: "pending", key: "stubwise-review", description: "d" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.url).toBe("https://bitbucket.org/myws/myrepo");
    expect(body).not.toHaveProperty("refname");
  });

  it("sha abbreviato → GitProviderError, nessuna richiesta", async () => {
    // Il doppio risponde 201 valido: senza il controllo sullo sha la chiamata
    // andrebbe a buon fine, e il test deve cadere sull'asserzione "nessuna
    // richiesta", non su un crash del doppio.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, 201)));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider
      .setCommitStatus(config, "abc123def456", { state: "pending", key: "stubwise-review", description: "d" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(GitProviderError);
  });

  it("non-2xx → GitProviderError con lo status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider
      .setCommitStatus(config, SHA, { state: "pending", key: "stubwise-review", description: "d" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(404);
    expect((error as GitProviderError).message).not.toContain("write:repository:bitbucket");
  });

  it("401 → GitProviderError che dice quale permesso manca, senza credenziali", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider
      .setCommitStatus(config, SHA, { state: "failure", key: "stubwise-review", description: "d" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(401);
    const message = (error as GitProviderError).message;
    expect(message).toContain(
      "il token deve poter scrivere gli status di commit (GitHub: Commit statuses write; Bitbucket: scope write:repository:bitbucket)"
    );
    expect(message).not.toContain("app-pass");
    expect(message).not.toContain(Buffer.from("alice:app-pass").toString("base64"));
  });
});

describe("BitbucketProvider.submitPrReview", () => {
  const PR = "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests/7";
  const AUTH = `Basic ${Buffer.from("alice:app-pass").toString("base64")}`;
  const HINT =
    "il token deve poter revisionare le pull request (GitHub: Pull requests write; Bitbucket: scope write:pullrequest:bitbucket)";

  /** Doppio che risponde bene a tutto, salvo le risposte forzate per "METODO url". */
  function recorder(overrides: Record<string, () => Promise<Response>> = {}) {
    return vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method} ${url}`;
      const forced = overrides[key];
      if (forced) return forced();
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 404 }));
      if (url === `${PR}/comments`) return Promise.resolve(jsonResponse({ id: 1 }, 201));
      return Promise.resolve(jsonResponse({ approved: true }, 200));
    });
  }
  const calls = (fetchImpl: ReturnType<typeof vi.fn>) =>
    fetchImpl.mock.calls.map((c) => `${(c as [string, RequestInit])[1].method} ${String((c as [string])[0])}`);
  const errorOf = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);

  it("approve: ritira request-changes, approva, poi il commento", async () => {
    const fetchImpl = recorder();
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.submitPrReview(config, 7, "approve", "Tutto a posto");

    expect(calls(fetchImpl)).toEqual([
      `DELETE ${PR}/request-changes`,
      `POST ${PR}/approve`,
      `POST ${PR}/comments`,
    ]);
    const withdraw = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((withdraw[1].headers as Record<string, string>)["Authorization"]).toBe(AUTH);
    const approve = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((approve[1].headers as Record<string, string>)["Authorization"]).toBe(AUTH);
    const comment = fetchImpl.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(comment[1].body as string)).toEqual({ content: { raw: "Tutto a posto" } });
  });

  it("request_changes: ritira approve, chiede modifiche, poi il commento", async () => {
    const fetchImpl = recorder();
    const provider = new BitbucketProvider({ fetchImpl });

    await provider.submitPrReview(config, 7, "request_changes", "Manca il test");

    expect(calls(fetchImpl)).toEqual([
      `DELETE ${PR}/approve`,
      `POST ${PR}/request-changes`,
      `POST ${PR}/comments`,
    ]);
  });

  it("corpo vuoto: nessun commento, solo lo stato", async () => {
    const fetchImpl = recorder();
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.submitPrReview(config, 7, "approve", "  ");
    expect(calls(fetchImpl)).toEqual([`DELETE ${PR}/request-changes`, `POST ${PR}/approve`]);
  });

  it("il DELETE rifiuta (errore di rete) → il verdetto parte comunque", async () => {
    const fetchImpl = recorder({
      [`DELETE ${PR}/request-changes`]: () => Promise.reject(new TypeError("fetch failed")),
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await errorOf(provider.submitPrReview(config, 7, "approve", ""));

    expect(error).toBeNull();
    expect(calls(fetchImpl)).toEqual([`DELETE ${PR}/request-changes`, `POST ${PR}/approve`]);
  });

  it("il verdetto fallisce → nessun commento pubblicato", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/approve`]: () => Promise.resolve(new Response("merged", { status: 400 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "approve", "testo"));
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(400);
    expect((error as GitProviderError).message).not.toContain(HINT);
    expect(calls(fetchImpl)).not.toContain(`POST ${PR}/comments`);
  });

  // SCELTA DIFENSIVA: un 409 sul verdetto non è un errore, lo stato è già
  // quello. Dal vivo (B14 T21) il secondo POST risponde 200, mai 409: il test
  // fissa un ramo che oggi non scatta, ed è innocuo tenerlo.
  it("409 sul verdetto → «già in quello stato»: nessun errore, il commento parte", async () => {
    for (const verdict of ["approve", "request_changes"] as const) {
      const submit = verdict === "approve" ? "approve" : "request-changes";
      // La risposta contiene (per assurdo) il token: l'estratto deve mascherarlo.
      const fetchImpl = recorder({
        [`POST ${PR}/${submit}`]: () =>
          Promise.resolve(
            new Response(`already approved by app-pass (${Buffer.from("alice:app-pass").toString("base64")})`, {
              status: 409,
            }),
          ),
      });
      const provider = new BitbucketProvider({ fetchImpl });

      // Il rifiuto diventa un valore: un 409 trattato come errore deve far
      // fallire l'ASSERZIONE qui sotto, non esplodere il test.
      const outcome = await provider.submitPrReview(config, 7, verdict, "Il testo").catch((e: unknown) => e);

      expect(outcome).toEqual({ status: "already_in_state", responseExcerpt: "already approved by *** (***)" });
      expect(calls(fetchImpl)).toContain(`POST ${PR}/comments`);
    }
  });

  it("verdetto riuscito → esito «submitted»", async () => {
    const provider = new BitbucketProvider({ fetchImpl: recorder() });
    await expect(provider.submitPrReview(config, 7, "approve", "ok")).resolves.toEqual({ status: "submitted" });
  });

  it("400/500 sul verdetto → errore, nessun commento (solo il 409 è «già in quello stato»)", async () => {
    for (const status of [400, 500]) {
      const fetchImpl = recorder({
        [`POST ${PR}/request-changes`]: () => Promise.resolve(new Response("nope", { status })),
      });
      const provider = new BitbucketProvider({ fetchImpl });
      const error = await errorOf(provider.submitPrReview(config, 7, "request_changes", "Manca il test"));
      expect(error).toBeInstanceOf(GitProviderError);
      expect((error as GitProviderError).status).toBe(status);
      expect(calls(fetchImpl)).not.toContain(`POST ${PR}/comments`);
    }
  });

  it("il commento fallisce dopo un verdetto riuscito → errore, verdetto già inviato", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/comments`]: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "request_changes", "Manca il test"));
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(500);
    // Distinguibile: il ripiego non deve dire «verdetto non apposto».
    expect(error).toBeInstanceOf(ReviewCommentFailedError);
    expect((error as ReviewCommentFailedError).verdictSubmitted).toBe(true);
    expect(calls(fetchImpl)).toEqual([
      `DELETE ${PR}/approve`,
      `POST ${PR}/request-changes`,
      `POST ${PR}/comments`,
    ]);
  });

  it("409 sul verdetto e commento che fallisce → il verdetto c'è comunque (ReviewCommentFailedError)", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/approve`]: () => Promise.resolve(new Response("already", { status: 409 })),
      [`POST ${PR}/comments`]: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "approve", "testo"));
    expect(error).toBeInstanceOf(ReviewCommentFailedError);
    expect((error as ReviewCommentFailedError).status).toBe(500);
  });

  it("il verdetto fallisce → NON è un ReviewCommentFailedError", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/approve`]: () => Promise.resolve(new Response("nope", { status: 403 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "approve", "testo"));
    expect(error).toBeInstanceOf(GitProviderError);
    expect(error).not.toBeInstanceOf(ReviewCommentFailedError);
  });

  it("400/500 sul commento → nessun suggerimento sui permessi", async () => {
    for (const status of [400, 500]) {
      const fetchImpl = recorder({
        [`POST ${PR}/comments`]: () => Promise.resolve(new Response("nope", { status })),
      });
      const provider = new BitbucketProvider({ fetchImpl });
      const error = await errorOf(provider.submitPrReview(config, 7, "approve", "testo"));
      expect(error).toBeInstanceOf(GitProviderError);
      expect((error as GitProviderError).status).toBe(status);
      expect((error as GitProviderError).message).not.toContain(HINT);
    }
  });

  it("403 sullo stato → il messaggio dice quale permesso manca, senza credenziali", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/request-changes`]: () => Promise.resolve(new Response("Forbidden", { status: 403 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "request_changes", ""));
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    const message = (error as GitProviderError).message;
    expect(message).toContain(HINT);
    expect(message).not.toContain("app-pass");
    expect(message).not.toContain(Buffer.from("alice:app-pass").toString("base64"));
  });

  it("401 sul commento → il messaggio dice quale permesso manca, senza credenziali", async () => {
    const fetchImpl = recorder({
      [`POST ${PR}/comments`]: () => Promise.resolve(new Response("Unauthorized", { status: 401 })),
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await errorOf(provider.submitPrReview(config, 7, "approve", "testo"));
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(401);
    const message = (error as GitProviderError).message;
    expect(message).toContain(HINT);
    expect(message).not.toContain("app-pass");
    expect(message).not.toContain(Buffer.from("alice:app-pass").toString("base64"));
  });
});

describe("BitbucketProvider.getAuthenticatedUserId", () => {
  const USER_URL = "https://api.bitbucket.org/2.0/user";
  const TOKEN_B64 = Buffer.from("alice:app-pass").toString("base64");

  it("GET /2.0/user con l'identità REST → uuid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ uuid: "{u-stubwise}", nickname: "stubwise-bot", account_id: "5f00" }, 200)
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const id = await provider.getAuthenticatedUserId({
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });

    expect(id).toBe("{u-stubwise}");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(USER_URL);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("senza email usa lo username (app password legacy)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-x}" }, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.getAuthenticatedUserId(config);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${TOKEN_B64}`);
  });

  it("accetta anche una ProjectGitConfig intera", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-x}" }, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).resolves.toBe("{u-x}");
  });

  it("opts.fetchImpl per chiamata vince su quello del costruttore", async () => {
    const ctorFetch = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-ctor}" }, 200));
    const callFetch = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-call}" }, 200));
    const provider = new BitbucketProvider({ fetchImpl: ctorFetch });
    await expect(provider.getAuthenticatedUserId(config, { fetchImpl: callFetch })).resolves.toBe("{u-call}");
    expect(ctorFetch).not.toHaveBeenCalled();
  });

  it("uuid GREZZO: graffe e maiuscole restano come le manda Bitbucket", async () => {
    const raw = "{A1B2C3D4-0000-4000-8000-00000000ABCD}";
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uuid: raw }, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).resolves.toBe(raw);
  });

  it("stessa fixture utente: === actorId del webhook === authorId dei commenti", async () => {
    // Il confronto del design §5 è un'uguaglianza di stringhe: la forma
    // dell'identità deve essere UNA sola nei tre punti.
    const user = {
      type: "user",
      uuid: "{A1b2C3d4-0000-4000-8000-000000000001}",
      nickname: "stubwise-bot",
      display_name: "Stubwise Bot",
      account_id: "5f00",
    };
    const fetchImpl = vi.fn().mockImplementation((input: string | URL) =>
      Promise.resolve(
        String(input) === USER_URL
          ? jsonResponse({ ...user }, 200)
          : jsonResponse(
              {
                values: [
                  {
                    id: 1,
                    created_on: "2026-09-30T10:01:00+00:00",
                    content: { raw: "da correggere" },
                    user: { ...user },
                    deleted: false,
                  },
                ],
              },
              200
            )
      )
    );
    const provider = new BitbucketProvider({ fetchImpl });

    const me = await provider.getAuthenticatedUserId(config);
    const [fromComment] = await provider.listPrComments(config, 7);
    const fromEvent = provider.parseChangesRequestedEvent(
      { "x-event-key": "pullrequest:changes_request_created" },
      {
        actor: { ...user },
        pullrequest: { id: 7, source: { branch: { name: "stubwise/ticket-1" } } },
        changes_request: { user: { ...user } },
      }
    );

    expect(me).toBe(user.uuid);
    expect(fromEvent?.actorId).toBe(me);
    expect(fromComment?.authorId).toBe(me);
  });

  it("401 → GitProviderError che dice credenziali non valide, senza il token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(401);
    const message = (error as GitProviderError).message;
    expect(message).toMatch(/credenziali/i);
    expect(message).not.toContain("app-pass");
    expect(message).not.toContain(TOKEN_B64);
  });

  it("403 → GitProviderError che nomina lo scope read:user:bitbucket, senza il token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(403);
    const message = (error as GitProviderError).message;
    expect(message).toContain("read:user:bitbucket");
    expect(message).not.toMatch(/app password/i);
    expect(message).not.toContain("app-pass");
    expect(message).not.toContain(TOKEN_B64);
  });

  it("altri non-2xx → GitProviderError con lo status vero, anche con un'identità nel corpo", async () => {
    // Corpo JSON VALIDO con uno uuid: se il controllo dello status mancasse,
    // la risposta verrebbe letta come un'identità buona.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-x}", nickname: "x" }, 500));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.getAuthenticatedUserId(config).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).status).toBe(500);
  });

  it.each([
    ["senza uuid", { nickname: "x" }],
    ["uuid vuoto", { uuid: "", nickname: "x" }],
    ["uuid non stringa", { uuid: 42 }],
    ["corpo null", null],
  ])("risposta %s → GitProviderError (mai una stringa vuota come identità)", async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId(config)).rejects.toBeInstanceOf(GitProviderError);
  });

  it("credenziali REST mancanti → lancia prima della richiesta", async () => {
    // Il doppio risponderebbe bene: se la richiesta partisse, il test lo vedrebbe.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uuid: "{u-x}" }, 200));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.getAuthenticatedUserId({ credentials: { token: "t" } })).rejects.toThrow(
      /email.*username|username.*email/i
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("BitbucketProvider.parseWebhook", () => {
  const provider = new BitbucketProvider();
  const mergedBody = {
    pullrequest: {
      id: 7,
      source: { branch: { name: "stubwise/fix-1" } },
      links: { html: { href: "https://bitbucket.org/myws/myrepo/pull-requests/7" } },
    },
  };

  it("recognizes pullrequest:fulfilled as merged and extracts the source branch", () => {
    const event = provider.parseWebhook({ "X-Event-Key": "pullrequest:fulfilled" }, mergedBody);
    expect(event).toEqual({
      kind: "merged",
      provider: "bitbucket",
      branch: "stubwise/fix-1",
      prUrl: "https://bitbucket.org/myws/myrepo/pull-requests/7",
      prNumber: 7,
    });
  });

  it("recognizes pullrequest:rejected as closed_unmerged", () => {
    const event = provider.parseWebhook({ "x-event-key": "pullrequest:rejected" }, mergedBody);
    expect(event).toEqual({
      kind: "closed_unmerged",
      provider: "bitbucket",
      branch: "stubwise/fix-1",
      prUrl: "https://bitbucket.org/myws/myrepo/pull-requests/7",
      prNumber: 7,
    });
  });

  it("exposes pullrequest.id as prNumber; id mancante/malformato → evento valido con prNumber null", () => {
    // La chiusura del ticket dipende dal branch, non dall'id PR: un payload
    // senza `id` resta un evento valido, solo il cleanup review lo salterà.
    const headers = { "x-event-key": "pullrequest:fulfilled" };
    expect(provider.parseWebhook(headers, mergedBody)?.prNumber).toBe(7);
    const withoutId: Record<string, unknown> = { ...mergedBody.pullrequest };
    delete withoutId["id"];
    const event = provider.parseWebhook(headers, { pullrequest: withoutId });
    expect(event).toEqual({
      kind: "merged",
      provider: "bitbucket",
      branch: "stubwise/fix-1",
      prUrl: "https://bitbucket.org/myws/myrepo/pull-requests/7",
      prNumber: null,
    });
    expect(
      provider.parseWebhook(headers, { pullrequest: { ...mergedBody.pullrequest, id: "7" } })
        ?.prNumber
    ).toBeNull();
  });

  it("matches the event header case-insensitively", () => {
    expect(provider.parseWebhook({ "x-event-key": "pullrequest:fulfilled" }, mergedBody)).not.toBeNull();
  });

  it("returns null for other event keys", () => {
    expect(provider.parseWebhook({ "x-event-key": "pullrequest:created" }, mergedBody)).toBeNull();
    expect(provider.parseWebhook({}, mergedBody)).toBeNull();
  });

  it("returns null (does not throw) on malformed bodies", () => {
    const headers = { "x-event-key": "pullrequest:fulfilled" };
    expect(provider.parseWebhook(headers, null)).toBeNull();
    expect(provider.parseWebhook(headers, "garbage")).toBeNull();
    expect(provider.parseWebhook(headers, { pullrequest: {} })).toBeNull();
    expect(provider.parseWebhook(headers, { pullrequest: { source: { branch: {} } } })).toBeNull();
  });
});

describe("BitbucketProvider.parsePrEvent", () => {
  const provider = new BitbucketProvider();
  const payload = {
    pullrequest: {
      id: 7,
      title: "Add login",
      description: "Implements login flow",
      source: { branch: { name: "feature/login" }, commit: { hash: "abc123def456" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "https://bitbucket.org/acme/repo/pull-requests/7" } },
    },
  };

  it("pullrequest:created → kind opened con tutti i campi", () => {
    expect(provider.parsePrEvent({ "x-event-key": "pullrequest:created" }, payload)).toEqual({
      kind: "opened",
      provider: "bitbucket",
      prNumber: 7,
      title: "Add login",
      description: "Implements login flow",
      sourceBranch: "feature/login",
      targetBranch: "main",
      headSha: "abc123def456",
      prUrl: "https://bitbucket.org/acme/repo/pull-requests/7",
    });
  });

  it("pullrequest:updated → kind updated", () => {
    expect(provider.parsePrEvent({ "x-event-key": "pullrequest:updated" }, payload)?.kind).toBe(
      "updated"
    );
  });

  it("matches the event header case-insensitively", () => {
    expect(provider.parsePrEvent({ "X-Event-Key": "pullrequest:created" }, payload)).not.toBeNull();
  });

  it("event-key di chiusura o assente → null", () => {
    expect(provider.parsePrEvent({ "x-event-key": "pullrequest:fulfilled" }, payload)).toBeNull();
    expect(provider.parsePrEvent({ "x-event-key": "pullrequest:rejected" }, payload)).toBeNull();
    expect(provider.parsePrEvent({}, payload)).toBeNull();
  });

  it("campi obbligatori mancanti o body malformato → null", () => {
    const headers = { "x-event-key": "pullrequest:created" };
    expect(provider.parsePrEvent(headers, null)).toBeNull();
    expect(provider.parsePrEvent(headers, "garbage")).toBeNull();
    expect(provider.parsePrEvent(headers, { pullrequest: {} })).toBeNull();
    const withoutSource: Record<string, unknown> = { ...payload.pullrequest };
    delete withoutSource["source"];
    expect(provider.parsePrEvent(headers, { pullrequest: withoutSource })).toBeNull();
    expect(
      provider.parsePrEvent(headers, {
        pullrequest: { ...payload.pullrequest, source: { branch: { name: "feature/login" } } },
      })
    ).toBeNull();
    expect(
      provider.parsePrEvent(headers, { pullrequest: { ...payload.pullrequest, id: "7" } })
    ).toBeNull();
  });

  it("description mancante → stringa vuota", () => {
    const withoutDescription: Record<string, unknown> = { ...payload.pullrequest };
    delete withoutDescription["description"];
    expect(
      provider.parsePrEvent({ "x-event-key": "pullrequest:created" }, { pullrequest: withoutDescription })
        ?.description
    ).toBe("");
  });
});

describe("BitbucketProvider.parseChangesRequestedEvent", () => {
  const provider = new BitbucketProvider();
  const headers = { "x-event-key": "pullrequest:changes_request_created" };
  const mario = { type: "user", uuid: "{u-mario}", nickname: "mario.rossi", display_name: "Mario Rossi" };
  const payload = () => ({
    actor: { ...mario },
    pullrequest: {
      id: 10,
      title: "Fix login",
      source: { branch: { name: "stubwise/ticket-42" }, commit: { hash: "abc123def456" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "https://bitbucket.org/myws/myrepo/pull-requests/10" } },
    },
    repository: { full_name: "myws/myrepo" },
    changes_request: { date: "2026-09-30T10:00:00+00:00", user: { ...mario } },
  });

  it("changes_request_created → PR, branch, autore (uuid + nickname), nessun testo", () => {
    expect(provider.parseChangesRequestedEvent(headers, payload())).toEqual({
      prNumber: 10,
      sourceBranch: "stubwise/ticket-42",
      actorId: "{u-mario}",
      actorLogin: "mario.rossi",
      reviewBody: null,
      // nessun dato di associazione su Bitbucket
      authorAssociation: null,
    });
  });

  it("header case-insensitive", () => {
    expect(
      provider.parseChangesRequestedEvent({ "X-Event-Key": "pullrequest:changes_request_created" }, payload())
    ).not.toBeNull();
  });

  // La consegna VERA di B14 (T25, 1 ott 2026), anonimizzata: le fixture qui
  // sopra sono scritte a mano dalla documentazione, questa viene dalla
  // piattaforma. Stessa forma: `changes_request.user` e `actor` coincidono, il
  // branch è in `pullrequest.source.branch.name`, nessun testo. I campi in più
  // (`account_id`, `participants`, `author`…) il parser li ignora.
  it("payload reale di Bitbucket (B14, anonimizzato) → PR, branch e revisore", () => {
    const real: unknown = JSON.parse(
      readFileSync(new URL("./__fixtures__/bitbucket-changes-request-created.json", import.meta.url), "utf8")
    );
    expect(
      provider.parseChangesRequestedEvent({ "X-Event-Key": "pullrequest:changes_request_created" }, real)
    ).toEqual({
      prNumber: 1,
      sourceBranch: "test/b14",
      actorId: "{37b0ddd0-c0c8-4522-932e-4a25f5dc6fa3}",
      actorLogin: "Revisore Esempio",
      reviewBody: null,
      authorAssociation: null,
    });
  });

  it("senza changes_request.user ripiega su actor; senza nickname usa display_name", () => {
    const p = payload() as Record<string, unknown>;
    delete p.changes_request;
    p.actor = { uuid: "{u-anna}", display_name: "Anna Bianchi" };
    expect(provider.parseChangesRequestedEvent(headers, p)).toMatchObject({
      actorId: "{u-anna}",
      actorLogin: "Anna Bianchi",
    });
  });

  it("actor e changes_request.user DIVERSI → null (non si sa di chi è: fail-closed)", () => {
    const p = payload();
    p.actor = { ...mario, uuid: "{u-altro}" };
    expect(provider.parseChangesRequestedEvent(headers, p)).toBeNull();
  });

  it("nessun uuid da nessuna parte → null", () => {
    const p = payload() as Record<string, unknown>;
    p.actor = { nickname: "x" };
    p.changes_request = { user: { nickname: "x" } };
    expect(provider.parseChangesRequestedEvent(headers, p)).toBeNull();
  });

  it("altri eventi → null, e gli altri parser non vedono questo evento", () => {
    expect(
      provider.parseChangesRequestedEvent({ "x-event-key": "pullrequest:changes_request_removed" }, payload())
    ).toBeNull();
    expect(provider.parseChangesRequestedEvent({ "x-event-key": "pullrequest:updated" }, payload())).toBeNull();
    // Mutua esclusione con la catena di apps/server/src/routes/webhooks.ts.
    expect(provider.parsePrEvent(headers, payload())).toBeNull();
    expect(provider.parseWebhook(headers, payload())).toBeNull();
    expect(provider.parsePushEvent(headers, payload())).toBeNull();
  });

  it("campi obbligatori mancanti o body malformato → null, senza lanciare", () => {
    const noId = payload();
    (noId.pullrequest as { id: unknown }).id = "10";
    expect(provider.parseChangesRequestedEvent(headers, noId)).toBeNull();
    const noBranch = payload();
    (noBranch.pullrequest as { source: unknown }).source = {};
    expect(provider.parseChangesRequestedEvent(headers, noBranch)).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, null)).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, "x")).toBeNull();
    expect(provider.parseChangesRequestedEvent(headers, { pullrequest: null })).toBeNull();
  });

  it("id della PR non intero → null", () => {
    const p = payload();
    (p.pullrequest as { id: unknown }).id = 1.5;
    expect(provider.parseChangesRequestedEvent(headers, p)).toBeNull();
  });
});
describe("BitbucketProvider.parsePushEvent", () => {
  const provider = new BitbucketProvider();
  const pushBody = {
    push: {
      changes: [
        {
          old: { target: { hash: "a".repeat(40) } },
          new: { type: "branch", name: "main", target: { hash: "b".repeat(40) } },
          commits: [
            { hash: "c".repeat(40), message: "first commit" },
            { hash: "d".repeat(40), message: "second commit" },
          ],
        },
      ],
    },
  };

  it("recognizes repo:push on a branch and maps branch, before/after and commits", () => {
    const event = provider.parsePushEvent({ "X-Event-Key": "repo:push" }, pushBody);
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

  it("matches the event header case-insensitively", () => {
    expect(provider.parsePushEvent({ "x-event-key": "repo:push" }, pushBody)).not.toBeNull();
  });

  it("uses 0*40 as beforeSha when old is absent (new branch)", () => {
    const body = {
      push: {
        changes: [
          { new: { type: "branch", name: "feature/x", target: { hash: "b".repeat(40) } }, commits: [] },
        ],
      },
    };
    const event = provider.parsePushEvent({ "x-event-key": "repo:push" }, body);
    expect(event).toEqual({
      branch: "feature/x",
      beforeSha: "0".repeat(40),
      afterSha: "b".repeat(40),
      commits: [],
    });
  });

  it("picks the first branch change, skipping non-branch (tag) changes", () => {
    const body = {
      push: {
        changes: [
          { new: { type: "tag", name: "v1.0.0", target: { hash: "f".repeat(40) } } },
          {
            old: { target: { hash: "a".repeat(40) } },
            new: { type: "branch", name: "main", target: { hash: "b".repeat(40) } },
          },
        ],
      },
    };
    const event = provider.parsePushEvent({ "x-event-key": "repo:push" }, body);
    expect(event?.branch).toBe("main");
    expect(event?.commits).toEqual([]);
  });

  it("returns null for a tag-only push (no branch change)", () => {
    const body = {
      push: { changes: [{ new: { type: "tag", name: "v1.0.0", target: { hash: "f".repeat(40) } } }] },
    };
    expect(provider.parsePushEvent({ "x-event-key": "repo:push" }, body)).toBeNull();
  });

  it("returns null for a branch delete (new === null)", () => {
    const body = { push: { changes: [{ old: { target: { hash: "a".repeat(40) } }, new: null }] } };
    expect(provider.parsePushEvent({ "x-event-key": "repo:push" }, body)).toBeNull();
  });

  it("returns null when the event key is not repo:push (a PR is not a push)", () => {
    const prBody = {
      pullrequest: {
        source: { branch: { name: "stubwise/fix-1" } },
        links: { html: { href: "https://bitbucket.org/myws/myrepo/pull-requests/7" } },
      },
    };
    expect(provider.parsePushEvent({ "x-event-key": "pullrequest:fulfilled" }, prBody)).toBeNull();
    expect(provider.parsePushEvent({}, pushBody)).toBeNull();
  });

  it("returns null (does not throw) on malformed bodies", () => {
    const headers = { "x-event-key": "repo:push" };
    expect(provider.parsePushEvent(headers, null)).toBeNull();
    expect(provider.parsePushEvent(headers, "garbage")).toBeNull();
    expect(provider.parsePushEvent(headers, {})).toBeNull();
    expect(provider.parsePushEvent(headers, { push: {} })).toBeNull();
    expect(provider.parsePushEvent(headers, { push: { changes: [] } })).toBeNull();
    expect(
      provider.parsePushEvent(headers, { push: { changes: [{ new: { type: "branch", name: "main" } }] } })
    ).toBeNull();
  });

  it("cross-check: a PR webhook stays a PR — parseWebhook parses it, parsePushEvent does not", () => {
    const prBody = {
      pullrequest: {
        id: 7,
        source: { branch: { name: "stubwise/fix-1" } },
        links: { html: { href: "https://bitbucket.org/myws/myrepo/pull-requests/7" } },
      },
    };
    expect(provider.parseWebhook({ "x-event-key": "pullrequest:fulfilled" }, prBody)).not.toBeNull();
    expect(provider.parsePushEvent({ "x-event-key": "pullrequest:fulfilled" }, prBody)).toBeNull();
  });
});

describe("BitbucketProvider.validateCredentials", () => {
  const apiConfig: ProjectGitConfig = {
    repoUrl: "https://bitbucket.org/myws/myrepo",
    defaultBranch: "main",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };

  const GIT_URL = "https://bitbucket.org/myws/myrepo.git/info/refs?service=git-receive-pack";
  const REST_URL = "https://api.bitbucket.org/2.0/repositories/myws/myrepo/pullrequests?pagelen=1";
  const HOOKS_URL = "https://api.bitbucket.org/2.0/repositories/myws/myrepo/hooks?pagelen=1";
  const MERGE_URL = `https://api.bitbucket.org/2.0/user/permissions/repositories?q=${encodeURIComponent('repository.full_name="myws/myrepo"')}`;

  /** Mock che risponde in base all'URL chiamato (git vs REST vs hooks vs merge). */
  function routedFetch(map: {
    git?: () => Response;
    rest?: () => Response;
    hooks?: () => Response;
    merge?: () => Response;
  }) {
    return vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === GIT_URL) return Promise.resolve(map.git?.() ?? new Response("", { status: 500 }));
      if (url === REST_URL) return Promise.resolve(map.rest?.() ?? new Response("", { status: 500 }));
      if (url === HOOKS_URL) return Promise.resolve(map.hooks?.() ?? new Response("", { status: 500 }));
      if (url === MERGE_URL) return Promise.resolve(map.merge?.() ?? new Response("", { status: 500 }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
  }

  it("tutto ok: i quattro check passano e usano le identità corrette", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
      merge: () => jsonResponse({ values: [{ permission: "write" }] }, 200),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[0]!.name).toBe("Accesso git (push)");
    expect(checks[1]!.name).toBe("Accesso REST API (PR)");
    expect(checks[2]!.name).toBe("Accesso webhook (config automatica)");
    expect(checks[3]!.name).toBe("Permesso di merge");

    // git usa username:token
    const gitCall = fetchImpl.mock.calls.find((c) => c[0] === GIT_URL) as unknown as [string, RequestInit];
    expect((gitCall[1].headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice:api-token").toString("base64")}`
    );
    // REST usa email:token (identità Atlassian)
    const restCall = fetchImpl.mock.calls.find((c) => c[0] === REST_URL) as unknown as [string, RequestInit];
    expect((restCall[1].headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
    // hooks usa email:token come la REST
    const hooksCall = fetchImpl.mock.calls.find((c) => c[0] === HOOKS_URL) as unknown as [string, RequestInit];
    expect((hooksCall[1].headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("permesso 'read' soltanto: merge ok:false, distinto da 'nessun permesso'", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
      merge: () => jsonResponse({ values: [{ permission: "read" }] }, 200),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const merge = checks.find((c) => c.name === "Permesso di merge")!;
    expect(merge.ok).toBe(false);
    expect(merge.detail).toMatch(/lettura/i);
    expect(merge.failure).toBe("no_write_permission");
  });

  it("nessun permesso trovato (values vuoto): merge ok:false", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
      merge: () => jsonResponse({ values: [] }, 200),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const merge = checks.find((c) => c.name === "Permesso di merge")!;
    expect(merge.ok).toBe(false);
  });

  it("permesso 'admin': merge ok:true", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
      merge: () => jsonResponse({ values: [{ permission: "admin" }] }, 200),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const merge = checks.find((c) => c.name === "Permesso di merge")!;
    expect(merge.ok).toBe(true);
  });

  it("merge 401: detail parla di autenticazione", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
      merge: () => new Response("", { status: 401 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const merge = checks.find((c) => c.name === "Permesso di merge")!;
    expect(merge.ok).toBe(false);
    expect(merge.detail).toMatch(/autenticazione/i);
  });

  it("hooks 403: check webhook ok:false con guida sullo scope, ma advisory", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("", { status: 403 }),
      merge: () => jsonResponse({ values: [{ permission: "write" }] }, 200),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    expect(checks).toHaveLength(4);
    const webhook = checks.find((c) => c.name === "Accesso webhook (config automatica)")!;
    expect(webhook.ok).toBe(false);
    expect(webhook.detail).toMatch(/webhook/i);
    // Nomenclatura degli API token, non quella OAuth (`webhook:write`).
    expect(webhook.detail).toContain("read:webhook:bitbucket");
    expect(webhook.detail).toContain("write:webhook:bitbucket");
  });

  it("REST 401: detail spiega che serve l'email come identità", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("", { status: 401 }),
      hooks: () => new Response("{}", { status: 200 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const rest = checks.find((c) => c.name === "Accesso REST API (PR)")!;
    expect(rest.ok).toBe(false);
    expect(rest.detail).toMatch(/email/i);
    expect(rest.detail).toContain("read:pullrequest:bitbucket");
    expect(rest.detail).toContain("write:pullrequest:bitbucket");
  });

  it("git 401: detail parla di username/token/scope write:repository:bitbucket", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 401 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const git = checks.find((c) => c.name === "Accesso git (push)")!;
    expect(git.ok).toBe(false);
    expect(git.detail).toMatch(/username/i);
    expect(git.detail).toMatch(/token/i);
    expect(git.detail).toContain("write:repository:bitbucket");
  });

  it("username mancante: il check git fallisce senza chiamare la rete per git", async () => {
    const fetchImpl = routedFetch({
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(
      { ...apiConfig, credentials: { email: "alice@corp.io", token: "api-token" } },
      { fetchImpl }
    );

    const git = checks.find((c) => c.name === "Accesso git (push)")!;
    expect(git.ok).toBe(false);
    expect(git.detail).toMatch(/username/i);
    expect(fetchImpl.mock.calls.some((c) => c[0] === GIT_URL)).toBe(false);
  });

  it("errore di rete: il check fallisce col messaggio dell'errore, senza lanciare", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED boom")));
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => !c.ok)).toBe(true);
    expect(checks[0]!.detail).toMatch(/ECONNREFUSED/);
  });
});

describe("BitbucketProvider.validateAccount", () => {
  const credentials: AccountCredentials = {
    provider: "bitbucket",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };
  const accountConfig = { credentials, workspace: "myws" };
  const ACCOUNT_URL = "https://api.bitbucket.org/2.0/repositories/myws?pagelen=1";

  it("200: check ok, con identità REST email:token; chiama /2.0/repositories/{workspace}", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });

    // Risposta senza header degli scope: il secondo check dice che non sono verificabili.
    expect(checks).toHaveLength(2);
    expect(checks[1]!.name).toBe("Scope del token");
    expect(checks[0]!.name).toBe("Autenticazione e accesso workspace");
    expect(checks[0]!.ok).toBe(true);
    expect(checks[0]!.detail).toMatch(/myws/);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ACCOUNT_URL);
    // NON deve usare gli endpoint account/globali dismessi (410 Gone).
    expect(url).not.toContain("repositories?role=member");
    expect(url).not.toContain("/2.0/workspaces");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("workspace mancante: un check fallito, nessuna chiamata di rete", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount({ credentials }, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/workspace Bitbucket mancante/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("401: check fallito con messaggio su email/token", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("nope", { status: 401 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/401/);
    expect(checks[0]!.detail).toMatch(/email|token/i);
  });

  it("403: check fallito con messaggio sull'accesso al workspace/scope", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 403 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/403/);
    expect(checks[0]!.detail).toMatch(/workspace/i);
    expect(checks[0]!.detail).toContain("read:repository:bitbucket");
  });

  it("404: check fallito con messaggio sullo slug del workspace", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/404|non trovato|slug/i);
  });

  it("410: check fallito con messaggio sull'endpoint non disponibile", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 410 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/410/);
  });

  it("email e username mancanti: un check fallito, nessuna chiamata di rete", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(
      { credentials: { provider: "bitbucket", credentials: { token: "api-token" } }, workspace: "myws" },
      { fetchImpl }
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/email Atlassian.*username|mancante/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("errore di rete: il check fallisce senza lanciare", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED boom")));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/ECONNREFUSED/);
  });
});

describe("BitbucketProvider.validateAccount: scope del token", () => {
  const credentials: AccountCredentials = {
    provider: "bitbucket",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };
  const accountConfig = { credentials, workspace: "myws" };
  const FULL =
    "read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:webhook:bitbucket, write:webhook:bitbucket";
  // Il token del revisore visto davvero sulla piattaforma (1 ott 2026): niente webhook.
  const REVIEWER =
    "read:user:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket";

  function respond(headers: Record<string, string>, status = 200) {
    return vi.fn(() => Promise.resolve(new Response("{}", { status, headers })));
  }
  const apiToken = (scopes: string) => ({ "x-credential-type": "api_token", "x-oauth-scopes": scopes });
  const byName = <C extends { name: string }>(checks: C[], name: string) => checks.find((c) => c.name === name);

  it("token completo, validato come principale (default): tutti i check ok, nessuna chiamata in più", async () => {
    const fetchImpl = respond(apiToken(FULL));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checks.map((c) => c.name)).toEqual([
      "Autenticazione e accesso workspace",
      "Scope repository e pull request",
      "Scope identità (read:user)",
      "Scope webhook",
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
    // Nessun `purpose`: `checkReviewAccount` del server filtra `webhook`.
    expect(checks.every((c) => c.purpose === undefined)).toBe(true);
  });

  it("token del revisore validato come revisore: ok, e il gruppo webhook non c'è", async () => {
    const fetchImpl = respond(apiToken(REVIEWER));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, {
      fetchImpl,
      requiredScopes: bitbucketRequiredScopes({ primary: false, reviewer: true }),
    });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byName(checks, "Scope webhook")).toBeUndefined();
    expect(byName(checks, "Scope identità (read:user)")?.ok).toBe(true);
  });

  it("lo stesso token validato come principale: ko sul gruppo webhook, che nomina gli scope mancanti", async () => {
    const fetchImpl = respond(apiToken(REVIEWER));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, {
      fetchImpl,
      requiredScopes: bitbucketRequiredScopes({ primary: true, reviewer: false }),
    });
    const webhook = byName(checks, "Scope webhook");
    expect(webhook?.ok).toBe(false);
    expect(webhook?.detail).toContain("read:webhook:bitbucket");
    expect(webhook?.detail).toContain("write:webhook:bitbucket");
    expect(byName(checks, "Scope repository e pull request")?.ok).toBe(true);
  });

  it("senza read:user: ko con il testo sui Request changes", async () => {
    const fetchImpl = respond(apiToken(FULL.replace("read:user:bitbucket, ", "")));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    const user = byName(checks, "Scope identità (read:user)");
    expect(user?.ok).toBe(false);
    expect(user?.detail).toContain("read:user:bitbucket");
    expect(user?.detail).toMatch(/Request changes da Bitbucket vengono scartati/);
    expect(byName(checks, "Scope webhook")?.ok).toBe(true);
  });

  it("scope repository mancante: ko bloccante anche per il revisore, nomina SOLO il mancante", async () => {
    const fetchImpl = respond(apiToken(REVIEWER.replace("write:repository:bitbucket, ", "")));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, {
      fetchImpl,
      requiredScopes: BITBUCKET_REVIEWER_SCOPES,
    });
    const repo = byName(checks, "Scope repository e pull request");
    expect(repo?.ok).toBe(false);
    expect(repo?.detail).toContain("write:repository:bitbucket");
    expect(repo?.detail).not.toContain("read:repository:bitbucket");
    expect(checks.every((c) => c.ok)).toBe(false);
  });

  it("header con formattazione varia (spazi, maiuscole, virgole senza spazio): tutti ok", async () => {
    const messy =
      "  READ:User:Bitbucket,read:repository:bitbucket ,  Write:Repository:Bitbucket,,read:pullrequest:bitbucket,write:pullrequest:bitbucket,read:webhook:bitbucket,WRITE:webhook:bitbucket ";
    const fetchImpl = respond({ "X-Credential-Type": " API_Token ", "X-OAuth-Scopes": messy });
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("parseBitbucketScopes: null se l'header manca, insieme normalizzato altrimenti", () => {
    expect(parseBitbucketScopes(null)).toBeNull();
    expect([...parseBitbucketScopes(" A:b ,c:D,, ")!]).toEqual(["a:b", "c:d"]);
  });

  it("header degli scope assente: check «non verificabili» che elenca cosa controllare, niente deduzioni", async () => {
    const fetchImpl = respond({ "x-credential-type": "api_token" });
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(2);
    const scope = byName(checks, "Scope del token");
    expect(scope?.ok).toBe(true);
    expect(scope?.detail).toMatch(/non verificabili/);
    for (const s of BITBUCKET_PRIMARY_SCOPES) expect(scope?.detail).toContain(s);
  });

  it("app password (x-credential-type diverso da api_token): non verificabile, anche se gli scope ci fossero", async () => {
    const fetchImpl = respond({ "x-credential-type": "app_password", "x-oauth-scopes": "repository:write" });
    const checks = await new BitbucketProvider().validateAccount(accountConfig, {
      fetchImpl,
      requiredScopes: BITBUCKET_REVIEWER_SCOPES,
    });
    expect(checks.map((c) => c.name)).toEqual(["Autenticazione e accesso workspace", "Scope del token"]);
    expect(checks[1]!.detail).toMatch(/non verificabili/);
    expect(checks[1]!.detail).not.toContain("webhook");
  });

  it("risposta non 2xx: nessun check sugli scope, il comportamento di prima resta", async () => {
    const fetchImpl = respond(apiToken(""), 403);
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/403/);
  });

  it("errore di rete: solo il check di autenticazione, nessun check sugli scope", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/network down/);
  });

  // D12: sul 403 Bitbucket dice nel corpo cosa serviva e cosa il token ha.
  it("403 con error.detail.required/granted: il dettaglio nomina SOLO gli scope richiesti mancanti", async () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        message: "Your credentials lack one or more required privilege scopes.",
        detail: { required: ["read:repository:bitbucket"], granted: ["read:user:bitbucket"] },
      },
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(body, { status: 403, headers: { "content-type": "application/json" } }))
    );
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/403/);
    expect(checks[0]!.detail).toContain("mancano read:repository:bitbucket");
    expect(checks[0]!.detail).not.toContain("read:user:bitbucket");
  });

  it("403 con error.detail.required stringa e granted che lo copre in parte", async () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        message: "x",
        detail: {
          required: "read:repository:bitbucket, read:pullrequest:bitbucket",
          granted: "read:pullrequest:bitbucket",
        },
      },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(body, { status: 403 })));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks[0]!.detail).toContain("mancano read:repository:bitbucket");
    expect(checks[0]!.detail).not.toContain("read:pullrequest:bitbucket");
  });

  it("x-oauth-scopes PRESENTE ma VUOTO su un api_token: non verificabile, non «manca tutto»", async () => {
    const fetchImpl = respond(apiToken(""));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, {
      fetchImpl,
      requiredScopes: BITBUCKET_REVIEWER_SCOPES,
    });
    expect(checks.map((c) => c.name)).toEqual(["Autenticazione e accesso workspace", "Scope del token"]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[1]!.detail).toMatch(/non verificabili/);
    // Anche solo spazi e virgole: nessuno scope dichiarato.
    const blank = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl: respond(apiToken(" , ")) });
    expect(blank.map((c) => c.name)).toEqual(["Autenticazione e accesso workspace", "Scope del token"]);
  });

  it("403 con un corpo che non arriva mai: Validate non resta appeso, dettaglio di sempre e stream cancellato", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const never = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(never, { status: 403 })));
      let settled = false;
      const pending = new BitbucketProvider().validateAccount(accountConfig, { fetchImpl }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const checks = await pending;
      expect(checks).toHaveLength(1);
      expect(checks[0]!.detail).toBe(
        "accesso negato (403): il token non ha accesso a questo workspace o manca lo scope read:repository:bitbucket"
      );
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("403 con corpo non JSON: il dettaglio di sempre", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("<html>Forbidden</html>", { status: 403 })));
    const checks = await new BitbucketProvider().validateAccount(accountConfig, { fetchImpl });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.detail).toBe(
      "accesso negato (403): il token non ha accesso a questo workspace o manca lo scope read:repository:bitbucket"
    );
  });
});

describe("bitbucketRequiredScopes", () => {
  it("principale: 7 scope, revisore: 5 (con i read accanto ai write), entrambi: l'unione, nessuno: il principale", () => {
    expect(new Set(BITBUCKET_PRIMARY_SCOPES)).toEqual(
      new Set([
        "read:repository:bitbucket",
        "write:repository:bitbucket",
        "read:pullrequest:bitbucket",
        "write:pullrequest:bitbucket",
        "read:webhook:bitbucket",
        "write:webhook:bitbucket",
        "read:user:bitbucket",
      ])
    );
    expect(new Set(BITBUCKET_REVIEWER_SCOPES)).toEqual(
      new Set([
        "read:repository:bitbucket",
        "write:repository:bitbucket",
        "read:pullrequest:bitbucket",
        "write:pullrequest:bitbucket",
        "read:user:bitbucket",
      ])
    );
    expect(new Set(bitbucketRequiredScopes({ primary: true, reviewer: false }))).toEqual(new Set(BITBUCKET_PRIMARY_SCOPES));
    expect(new Set(bitbucketRequiredScopes({ primary: false, reviewer: true }))).toEqual(new Set(BITBUCKET_REVIEWER_SCOPES));
    expect(new Set(bitbucketRequiredScopes({ primary: true, reviewer: true }))).toEqual(new Set(BITBUCKET_PRIMARY_SCOPES));
    expect(bitbucketRequiredScopes({ primary: true, reviewer: true })).toHaveLength(7);
    expect(new Set(bitbucketRequiredScopes({ primary: false, reviewer: false }))).toEqual(new Set(BITBUCKET_PRIMARY_SCOPES));
  });
});

describe("BitbucketProvider.ensureWebhook", () => {
  const apiConfig: ProjectGitConfig = {
    repoUrl: "https://bitbucket.org/myws/myrepo",
    defaultBranch: "main",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };
  const hook = { url: "https://stubwise.example.com/webhooks/git/demo", secret: "hmac-secret" };
  const LIST_URL = "https://api.bitbucket.org/2.0/repositories/myws/myrepo/hooks";
  const PAGE1_URL = `${LIST_URL}?pagelen=100`;
  const EXPECTED_AUTH = `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`;

  it("crea il webhook quando assente: POST con evento, secret e auth REST corretti", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PAGE1_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse({ values: [] }, 200));
      }
      if (url === LIST_URL && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ uuid: "{new-uuid}", url: hook.url }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.ensureWebhook(apiConfig, hook);

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.id).toBe("{new-uuid}");

    const post = fetchImpl.mock.calls.find((c) => c[1]?.method === "POST") as [string, RequestInit];
    expect(post[0]).toBe(LIST_URL);
    expect((post[1].headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    expect(JSON.parse(post[1].body as string)).toEqual({
      description: "Stubwise",
      url: hook.url,
      active: true,
      events: [
        "pullrequest:created",
        "pullrequest:updated",
        "pullrequest:fulfilled",
        "pullrequest:rejected",
        "pullrequest:changes_request_created",
        "repo:push",
      ],
      secret: hook.secret,
    });
  });

  it("aggiorna il webhook esistente: PUT all'uuid trovato con stesso URL", async () => {
    // L'hook già configurato in produzione ha la lista eventi VECCHIA: il
    // riallineamento (script resync-webhooks) passa da qui e deve riscriverla
    // in place, senza crearne un secondo.
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PAGE1_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          jsonResponse(
            {
              values: [
                {
                  uuid: "{existing}",
                  url: hook.url,
                  active: false,
                  events: [
                    "pullrequest:created",
                    "pullrequest:updated",
                    "pullrequest:fulfilled",
                    "pullrequest:rejected",
                    "repo:push",
                  ],
                },
              ],
            },
            200
          )
        );
      }
      if (url === `${LIST_URL}/{existing}` && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ uuid: "{existing}", url: hook.url }, 200));
      }
      // Anche una creazione riceverebbe una risposta valida: se partisse un
      // POST, il test deve fallire sull'asserzione "nessun duplicato", non
      // su un errore del doppio.
      if (url === LIST_URL && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ uuid: "{duplicate}", url: hook.url }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.ensureWebhook(apiConfig, hook);

    // Nessun duplicato: un solo aggiornamento in place, nessuna creazione.
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    const puts = fetchImpl.mock.calls.filter((c) => c[1]?.method === "PUT");
    expect(puts).toHaveLength(1);

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("{existing}");

    const put = puts[0] as [string, RequestInit];
    expect(put[0]).toBe(`${LIST_URL}/{existing}`);
    expect(JSON.parse(put[1].body as string)).toEqual({
      description: "Stubwise",
      url: hook.url,
      active: true,
      events: [
        "pullrequest:created",
        "pullrequest:updated",
        "pullrequest:fulfilled",
        "pullrequest:rejected",
        "pullrequest:changes_request_created",
        "repo:push",
      ],
      secret: hook.secret,
    });
  });

  /** Una pagina di hook col cursore `next` (assente se ultima). */
  function hookPage(values: unknown[], next: string | null): Response {
    return jsonResponse(next ? { values, next } : { values }, 200);
  }
  const PAGE2_URL = `${LIST_URL}?pagelen=100&page=2`;
  const otherHook = (n: number) => ({ uuid: `{other-${n}}`, url: `https://altro.example.com/hook/${n}` });

  it("hook esistente in SECONDA pagina: PUT su quello, nessun POST (nessun duplicato)", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") {
        return Promise.resolve(hookPage([otherHook(1), otherHook(2)], PAGE2_URL));
      }
      if (url === PAGE2_URL && method === "GET") {
        return Promise.resolve(hookPage([otherHook(3), { uuid: "{existing}", url: hook.url }], null));
      }
      if (url === `${LIST_URL}/{existing}` && method === "PUT") {
        return Promise.resolve(jsonResponse({ uuid: "{existing}", url: hook.url }, 200));
      }
      // Il duplicato riceverebbe una risposta valida: deve fallire
      // l'asserzione "nessun POST", non il doppio.
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ uuid: "{duplicate}", url: hook.url }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.ensureWebhook(apiConfig, hook);

    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    const puts = fetchImpl.mock.calls.filter((c) => c[1]?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]![0]).toBe(`${LIST_URL}/{existing}`);
    expect(result).toMatchObject({ created: false, updated: true, id: "{existing}" });
  });

  it("nessun hook in nessuna pagina: legge tutte le pagine e fa UN solo POST", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") return Promise.resolve(hookPage([otherHook(1)], PAGE2_URL));
      if (url === PAGE2_URL && method === "GET") return Promise.resolve(hookPage([otherHook(2)], null));
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ uuid: "{new-uuid}", url: hook.url }, 201));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.ensureWebhook(apiConfig, hook);

    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toContain(PAGE2_URL);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    expect(result).toMatchObject({ created: true, updated: false, id: "{new-uuid}" });
  });

  it("next verso un host estraneo: GitProviderError, nessuna richiesta lì e nessun POST", async () => {
    const evil = "https://evil.example.com/2.0/repositories/myws/myrepo/hooks?page=2";
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PAGE1_URL && method === "GET") return Promise.resolve(hookPage([otherHook(1)], evil));
      if (url === LIST_URL && method === "POST") {
        return Promise.resolve(jsonResponse({ uuid: "{duplicate}", url: hook.url }, 201));
      }
      return Promise.resolve(hookPage([{ uuid: "{existing}", url: hook.url }], null));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
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
      if (method === "POST") return Promise.resolve(jsonResponse({ uuid: "{duplicate}", url: hook.url }, 201));
      const n = Number(new URL(url).searchParams.get("page") ?? "1");
      return Promise.resolve(hookPage([otherHook(n)], `${LIST_URL}?pagelen=100&page=${n + 1}`));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
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
      if (method === "POST") return Promise.resolve(jsonResponse({ uuid: "{duplicate}", url: hook.url }, 201));
      return Promise.resolve(jsonResponse({ error: "not a page" }, 200));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect(fetchImpl.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("403 sulla lista: GitProviderError con guida sullo scope webhook", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 })));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/scope|webhook/i);
    expect((error as GitProviderError).message).toContain("read:webhook:bitbucket");
    expect((error as GitProviderError).message).toContain("write:webhook:bitbucket");
  });

  it("403 sulla creazione: GitProviderError con guida sullo scope webhook", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PAGE1_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse({ values: [] }, 200));
      }
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/webhook/i);
  });

  it("errore di rete: lanciato come GitProviderError (mai un errore grezzo)", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED boom")));
    const provider = new BitbucketProvider({ fetchImpl });

    const error = await provider
      .ensureWebhook(apiConfig, hook)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/ECONNREFUSED/);
  });
});

describe("BitbucketProvider.verifyWebhook", () => {
  const provider = new BitbucketProvider();
  const secret = "shh-bitbucket";
  const rawBody = JSON.stringify({ hello: "world" });
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts a valid X-Hub-Signature HMAC", () => {
    expect(provider.verifyWebhook({ "x-hub-signature": signature }, rawBody, secret)).toBe(true);
    expect(provider.verifyWebhook({ "X-Hub-Signature": signature }, rawBody, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(provider.verifyWebhook({ "x-hub-signature": signature }, rawBody + "tampered", secret)).toBe(false);
    expect(provider.verifyWebhook({ "x-hub-signature": "sha256=deadbeef" }, rawBody, secret)).toBe(false);
  });

  it("rejects when the header is missing", () => {
    expect(provider.verifyWebhook({}, rawBody, secret)).toBe(false);
  });
});

const credentials: AccountCredentials = {
  provider: "bitbucket",
  credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
};
const account = { credentials, workspace: "myws" };

function bbRepo(fullName: string, mainbranch: string | null) {
  return {
    full_name: fullName,
    name: fullName.split("/")[1],
    mainbranch: mainbranch ? { name: mainbranch } : undefined,
    links: {
      clone: [
        { name: "https", href: `https://bitbucket.org/${fullName}.git` },
        { name: "ssh", href: `git@bitbucket.org:${fullName}.git` },
      ],
    },
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const REPOS_URL = "https://api.bitbucket.org/2.0/repositories/myws?pagelen=100&sort=-updated_on";

describe("BitbucketProvider.listRepositories", () => {
  it("elenca i repo del workspace mappando i RepoSummary con auth email:token", async () => {
    const fetchImpl = vi.fn((input: string | URL, _init?: RequestInit) => {
      void _init;
      const url = String(input);
      if (url === REPOS_URL) {
        return Promise.resolve(jsonOk({ values: [bbRepo("myws/repo-a", "main"), bbRepo("myws/repo-b", null)] }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const repos = await provider.listRepositories(account);
    expect(repos).toEqual([
      { fullName: "myws/repo-a", name: "repo-a", cloneUrl: "https://bitbucket.org/myws/repo-a.git", defaultBranch: "main" },
      { fullName: "myws/repo-b", name: "repo-b", cloneUrl: "https://bitbucket.org/myws/repo-b.git", defaultBranch: null },
    ]);

    // Unica risorsa interrogata: GET /2.0/repositories/{workspace} (NON gli
    // endpoint account/globali dismessi).
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe(REPOS_URL);
    expect(String(firstUrl)).not.toContain("repositories?role=member");
    expect(String(firstUrl)).not.toContain("/2.0/workspaces");
    const headers = (firstInit.headers as Record<string, string>) ?? {};
    // base64("alice@corp.io:api-token")
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`);
  });

  it("workspace mancante → GitProviderError, nessuna chiamata di rete", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories({ credentials })).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories({ credentials })).rejects.toThrow(/workspace Bitbucket mancante/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("costruisce il cloneUrl di fallback quando manca il clone https", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      void input;
      return Promise.resolve(
        jsonOk({ values: [{ full_name: "myws/repo-x", name: "repo-x", links: { clone: [] } }] }),
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const repos = await provider.listRepositories(account);
    expect(repos).toEqual([
      { fullName: "myws/repo-x", name: "repo-x", cloneUrl: "https://bitbucket.org/myws/repo-x.git", defaultBranch: null },
    ]);
  });

  it("segue `next` ma rispetta il tetto di pagine (~3) e ~300 repo", async () => {
    let page = 0;
    const fetchImpl = vi.fn((input: string | URL) => {
      void input;
      page++;
      const values = Array.from({ length: 100 }, (_, i) => bbRepo(`myws/r-${page}-${i}`, "main"));
      return Promise.resolve(
        jsonOk({ values, next: `https://api.bitbucket.org/2.0/repositories/myws?page=${page + 1}` }),
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const repos = await provider.listRepositories(account);
    expect(repos).toHaveLength(300);
    // 3 chiamate (cap MAX_REPO_PAGES).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("401 sul listing → GitProviderError in italiano", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/autenticazione|401/i);
  });

  it("403 sul listing → GitProviderError in italiano", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/403|accesso negato/i);
  });

  it("404 sul listing → GitProviderError in italiano", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/404|workspace|repository/i);
  });

  it("410 sul listing → GitProviderError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("gone", { status: 410 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/410/);
  });
});

describe("BitbucketProvider.listBranches", () => {
  it("returns the default branch from the repo and the branch names", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === "https://api.bitbucket.org/2.0/repositories/myws/repo") {
        return Promise.resolve(
          new Response(JSON.stringify({ mainbranch: { name: "develop" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.includes("/refs/branches")) {
        return Promise.resolve(
          new Response(JSON.stringify({ values: [{ name: "main" }, { name: "develop" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.listBranches(credentials, "myws/repo");
    expect(result.defaultBranch).toBe("develop");
    expect(result.branches).toEqual(["main", "develop"]);
  });

  it("caps branches at ~200 via the `next` cursor", async () => {
    let page = 0;
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === "https://api.bitbucket.org/2.0/repositories/myws/repo") {
        return Promise.resolve(
          new Response(JSON.stringify({ mainbranch: { name: "main" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      page++;
      const values = Array.from({ length: 100 }, (_, i) => ({ name: `b-${page}-${i}` }));
      return Promise.resolve(
        new Response(
          JSON.stringify({ values, next: `https://api.bitbucket.org/2.0/repositories/myws/repo/refs/branches?page=${page + 1}` }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const result = await provider.listBranches(credentials, "myws/repo");
    expect(result.branches).toHaveLength(200);
  });

  it("401 → GitProviderError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listBranches(credentials, "myws/repo")).rejects.toBeInstanceOf(GitProviderError);
  });
});

describe("BitbucketProvider: un `next` fuori da api.bitbucket.org non viene seguito", () => {
  // Il cursore `next` lo scrive la risposta: se puntasse altrove, seguirlo
  // consegnerebbe l'header Authorization a un host scelto da quella risposta.
  const EVIL = "https://api.bitbucket.org.evil.example/2.0/page=2";

  /** Ogni URL fuori dall'API risponde 200 vuoto: se il metodo lo seguisse,
   * il test lo vedrebbe fra le chiamate, non come un errore di rete. */
  function fetchWith(firstPages: (url: string) => unknown) {
    return vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (!url.startsWith("https://api.bitbucket.org/")) return Promise.resolve(jsonOk({ values: [] }));
      return Promise.resolve(jsonOk(firstPages(url)));
    });
  }

  function expectBlocked(error: unknown, fetchImpl: ReturnType<typeof vi.fn>) {
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/host inatteso/);
    expect((error as GitProviderError).message).not.toContain("api-token");
    expect((error as GitProviderError).message).not.toContain("app-pass");
    const calledUrls = fetchImpl.mock.calls.map((c) => String((c as [string])[0]));
    expect(calledUrls).not.toContain(EVIL);
    expect(calledUrls.every((u) => u.startsWith("https://api.bitbucket.org/"))).toBe(true);
  }

  it("listPrComments", async () => {
    const fetchImpl = fetchWith(() => ({
      values: [{ id: 1, created_on: "2026-09-30T10:00:00+00:00", content: { raw: "x" }, user: { uuid: "{u}" } }],
      next: EVIL,
    }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.listPrComments(config, 7).then(() => null, (e: unknown) => e);
    expectBlocked(error, fetchImpl);
  });

  it("listRepositories", async () => {
    const fetchImpl = fetchWith(() => ({ values: [bbRepo("myws/a", "main")], next: EVIL }));
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.listRepositories(account).then(() => null, (e: unknown) => e);
    expectBlocked(error, fetchImpl);
  });

  it("listBranches", async () => {
    const fetchImpl = fetchWith((url) =>
      url.includes("/refs/branches") ? { values: [{ name: "main" }], next: EVIL } : { mainbranch: { name: "main" } }
    );
    const provider = new BitbucketProvider({ fetchImpl });
    const error = await provider.listBranches(credentials, "myws/repo").then(() => null, (e: unknown) => e);
    expectBlocked(error, fetchImpl);
  });
});

describe("BitbucketProvider — ciclo di correzione: scopo dei controlli e tempi massimi (1 ott 2026)", () => {
  const apiConfig: ProjectGitConfig = {
    repoUrl: "https://bitbucket.org/myws/myrepo",
    defaultBranch: "main",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };

  it("validateCredentials dichiara lo scopo di ogni controllo: push, rest, webhook, merge", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/hooks?")) return Promise.resolve(new Response("", { status: 403 }));
      if (url.includes("/user/permissions/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ values: [{ permission: "write" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const checks = await new BitbucketProvider().validateCredentials(apiConfig, { fetchImpl });

    expect(checks.map((c) => [c.purpose, c.ok])).toEqual([
      ["push", true],
      ["rest", true],
      ["webhook", false],
      ["merge", true],
    ]);
  });

  it("getAuthenticatedUserId: un provider che non risponde diventa un errore, non un'attesa senza limite", async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("richiesta interrotta (timeout)")));
        })
    );
    const provider = new BitbucketProvider({ fetchImpl });

    await expect(provider.getAuthenticatedUserId(apiConfig, { timeoutMs: 20 })).rejects.toThrow(/timeout/);
  });
});

describe("BitbucketProvider — i metodi del ciclo hanno un tempo massimo (1 ott 2026)", () => {
  it("submitPrReview: un provider che non risponde diventa un errore dopo il timeout di default", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("richiesta interrotta (timeout)")));
          })
      );
      const provider = new BitbucketProvider({ fetchImpl });
      const pending = provider.submitPrReview(
        {
          repoUrl: "https://bitbucket.org/myws/myrepo",
          defaultBranch: "main",
          credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
        },
        7,
        "approve",
        ""
      );
      const outcome = expect(pending).rejects.toThrow(/timeout/);
      // Due richieste in sequenza: il ritiro (best-effort) e l'invio.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
