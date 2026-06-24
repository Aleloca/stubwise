import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitProviderError, type AccountCredentials, type ProjectGitConfig } from "./provider.js";

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

describe("BitbucketProvider.parseWebhook", () => {
  const provider = new BitbucketProvider();
  const mergedBody = {
    pullrequest: {
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
    });
  });

  it("recognizes pullrequest:rejected as closed_unmerged", () => {
    const event = provider.parseWebhook({ "x-event-key": "pullrequest:rejected" }, mergedBody);
    expect(event).toEqual({
      kind: "closed_unmerged",
      provider: "bitbucket",
      branch: "stubwise/fix-1",
      prUrl: "https://bitbucket.org/myws/myrepo/pull-requests/7",
    });
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

  /** Mock che risponde in base all'URL chiamato (git vs REST vs hooks). */
  function routedFetch(map: { git?: () => Response; rest?: () => Response; hooks?: () => Response }) {
    return vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === GIT_URL) return Promise.resolve(map.git?.() ?? new Response("", { status: 500 }));
      if (url === REST_URL) return Promise.resolve(map.rest?.() ?? new Response("", { status: 500 }));
      if (url === HOOKS_URL) return Promise.resolve(map.hooks?.() ?? new Response("", { status: 500 }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
  }

  it("tutto ok: i tre check passano e usano le identità corrette", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[0]!.name).toBe("Accesso git (push)");
    expect(checks[1]!.name).toBe("Accesso REST API (PR)");
    expect(checks[2]!.name).toBe("Accesso webhook (config automatica)");

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

  it("hooks 403: check webhook ok:false con guida sullo scope, ma advisory", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 200 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("", { status: 403 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    expect(checks).toHaveLength(3);
    const webhook = checks.find((c) => c.name === "Accesso webhook (config automatica)")!;
    expect(webhook.ok).toBe(false);
    expect(webhook.detail).toMatch(/webhook/i);
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
    expect(rest.detail).toMatch(/pullrequest/i);
  });

  it("git 401: detail parla di username/token/scope repository:write", async () => {
    const fetchImpl = routedFetch({
      git: () => new Response("", { status: 401 }),
      rest: () => new Response("{}", { status: 200 }),
      hooks: () => new Response("{}", { status: 200 }),
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateCredentials(apiConfig, { fetchImpl });

    const git = checks.find((c) => c.name === "Accesso git (push)")!;
    expect(git.ok).toBe(false);
    expect(git.detail).toMatch(/repository:write|username|token/i);
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

    expect(checks).toHaveLength(3);
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

  it("200: un solo check ok, con identità REST email:token; chiama /2.0/repositories/{workspace}", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(accountConfig, { fetchImpl });

    expect(checks).toHaveLength(1);
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
    expect(checks[0]!.detail).toMatch(/workspace|scope/i);
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

describe("BitbucketProvider.ensureWebhook", () => {
  const apiConfig: ProjectGitConfig = {
    repoUrl: "https://bitbucket.org/myws/myrepo",
    defaultBranch: "main",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };
  const hook = { url: "https://stubwise.example.com/webhooks/git/demo", secret: "hmac-secret" };
  const LIST_URL = "https://api.bitbucket.org/2.0/repositories/myws/myrepo/hooks";
  const EXPECTED_AUTH = `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`;

  it("crea il webhook quando assente: POST con evento, secret e auth REST corretti", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === LIST_URL && (init?.method ?? "GET") === "GET") {
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
      events: ["pullrequest:fulfilled", "pullrequest:rejected"],
      secret: hook.secret,
    });
  });

  it("aggiorna il webhook esistente: PUT all'uuid trovato con stesso URL", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === LIST_URL && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          jsonResponse({ values: [{ uuid: "{existing}", url: hook.url, active: false }] }, 200)
        );
      }
      if (url === `${LIST_URL}/{existing}` && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ uuid: "{existing}", url: hook.url }, 200));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const result = await provider.ensureWebhook(apiConfig, hook);

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("{existing}");

    const put = fetchImpl.mock.calls.find((c) => c[1]?.method === "PUT") as [string, RequestInit];
    expect(put[0]).toBe(`${LIST_URL}/{existing}`);
    expect(JSON.parse(put[1].body as string)).toEqual({
      description: "Stubwise",
      url: hook.url,
      active: true,
      events: ["pullrequest:fulfilled", "pullrequest:rejected"],
      secret: hook.secret,
    });
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
  });

  it("403 sulla creazione: GitProviderError con guida sullo scope webhook", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === LIST_URL && (init?.method ?? "GET") === "GET") {
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
