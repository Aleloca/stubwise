import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { GitProviderError, type AccountCredentials, type ProjectGitConfig } from "./provider.js";

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

  it("returns null when the PR number is missing or not a number", () => {
    const headers = { "x-github-event": "pull_request" };
    const withoutNumber: Record<string, unknown> = { ...mergedBody.pull_request };
    delete withoutNumber["number"];
    expect(provider.parseWebhook(headers, { ...mergedBody, pull_request: withoutNumber })).toBeNull();
    expect(
      provider.parseWebhook(headers, {
        ...mergedBody,
        pull_request: { ...mergedBody.pull_request, number: "7" },
      })
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
    expect(checks[1]!.name).toBe("Permessi repository (PR)");
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

    const pr = checks.find((c) => c.name === "Permessi repository (PR)")!;
    expect(pr.ok).toBe(false);
    expect(pr.detail).toMatch(/scrittura/i);
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
  const expectedBody = {
    name: "web",
    active: true,
    events: ["pull_request", "push"],
    config: { url: hook.url, content_type: "json", secret: hook.secret, insecure_ssl: "0" },
  };

  it("crea il webhook quando assente: POST con body e Bearer corretti", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === LIST_URL && (init?.method ?? "GET") === "GET") {
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
      if (url === LIST_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse([{ id: 7, config: { url: hook.url } }], 200));
      }
      if (url === `${LIST_URL}/7` && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ id: 7, config: { url: hook.url } }, 200));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new GitHubProvider({ fetchImpl });

    const result = await provider.ensureWebhook(config, hook);

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("7");

    const patch = fetchImpl.mock.calls.find((c) => c[1]?.method === "PATCH") as [string, RequestInit];
    expect(patch[0]).toBe(`${LIST_URL}/7`);
    expect(JSON.parse(patch[1].body as string)).toEqual({
      active: true,
      events: ["pull_request", "push"],
      config: { url: hook.url, content_type: "json", secret: hook.secret, insecure_ssl: "0" },
    });
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
