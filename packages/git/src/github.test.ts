import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { GitProviderError, type ProjectGitConfig } from "./provider.js";

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
      merged: true,
      head: { ref: "stubwise/fix-1" },
      html_url: "https://github.com/octo/repo/pull/42",
    },
  };

  it("recognizes pull_request closed+merged and extracts the head branch", () => {
    const event = provider.parseWebhook({ "X-GitHub-Event": "pull_request" }, mergedBody);
    expect(event).toEqual({
      provider: "github",
      branch: "stubwise/fix-1",
      prUrl: "https://github.com/octo/repo/pull/42",
    });
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

  it("returns null when the PR was closed without merging", () => {
    const body = { ...mergedBody, pull_request: { ...mergedBody.pull_request, merged: false } };
    expect(provider.parseWebhook({ "x-github-event": "pull_request" }, body)).toBeNull();
  });

  it("returns null (does not throw) on malformed bodies", () => {
    const headers = { "x-github-event": "pull_request" };
    expect(provider.parseWebhook(headers, null)).toBeNull();
    expect(provider.parseWebhook(headers, 42)).toBeNull();
    expect(provider.parseWebhook(headers, { action: "closed" })).toBeNull();
    expect(provider.parseWebhook(headers, { action: "closed", pull_request: { merged: true } })).toBeNull();
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

describe("GitHubProvider.ensureWebhook", () => {
  const hook = { url: "https://stubwise.example.com/webhooks/git/demo", secret: "hmac-secret" };
  const LIST_URL = "https://api.github.com/repos/octo/repo/hooks";
  const expectedBody = {
    name: "web",
    active: true,
    events: ["pull_request"],
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
      events: ["pull_request"],
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
