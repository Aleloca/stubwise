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

  it("recognizes pullrequest:fulfilled and extracts the source branch", () => {
    const event = provider.parseWebhook({ "X-Event-Key": "pullrequest:fulfilled" }, mergedBody);
    expect(event).toEqual({
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
  const account: AccountCredentials = {
    provider: "bitbucket",
    credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
  };
  const ACCOUNT_URL = "https://api.bitbucket.org/2.0/workspaces?pagelen=1";

  it("200: un solo check ok, con identità REST email:token; chiama /2.0/workspaces", async () => {
    const fetchImpl = vi.fn((input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });

    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("Autenticazione e accesso workspace");
    expect(checks[0]!.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ACCOUNT_URL);
    // NON deve usare l'endpoint deprecato repositories?role=member (410 Gone).
    expect(url).not.toContain("repositories?role=member");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`
    );
  });

  it("401: check fallito con messaggio su email/token", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("nope", { status: 401 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/401/);
    expect(checks[0]!.detail).toMatch(/email|token/i);
  });

  it("403: check fallito con messaggio sugli scope del token", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 403 })));
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(account, { fetchImpl });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/403/);
    expect(checks[0]!.detail).toMatch(/scope/i);
  });

  it("email e username mancanti: un check fallito, nessuna chiamata di rete", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider();
    const checks = await provider.validateAccount(
      { provider: "bitbucket", credentials: { token: "api-token" } },
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
    const checks = await provider.validateAccount(account, { fetchImpl });
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
      events: ["pullrequest:fulfilled"],
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
      events: ["pullrequest:fulfilled"],
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

const account: AccountCredentials = {
  provider: "bitbucket",
  credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
};

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

const WORKSPACES_URL = "https://api.bitbucket.org/2.0/workspaces?pagelen=100";

describe("BitbucketProvider.listRepositories", () => {
  it("elenca i workspace e poi i repo per workspace, fondendo i RepoSummary con auth email:token", async () => {
    const fetchImpl = vi.fn((input: string | URL, _init?: RequestInit) => {
      void _init;
      const url = String(input);
      if (url === WORKSPACES_URL) {
        return Promise.resolve(jsonOk({ values: [{ slug: "ws1" }, { slug: "ws2" }] }));
      }
      if (url === "https://api.bitbucket.org/2.0/repositories/ws1?pagelen=100&sort=-updated_on") {
        return Promise.resolve(jsonOk({ values: [bbRepo("ws1/repo-a", "main")] }));
      }
      if (url === "https://api.bitbucket.org/2.0/repositories/ws2?pagelen=100&sort=-updated_on") {
        return Promise.resolve(jsonOk({ values: [bbRepo("ws2/repo-b", null)] }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });

    const repos = await provider.listRepositories(account);
    expect(repos).toEqual([
      { fullName: "ws1/repo-a", name: "repo-a", cloneUrl: "https://bitbucket.org/ws1/repo-a.git", defaultBranch: "main" },
      { fullName: "ws2/repo-b", name: "repo-b", cloneUrl: "https://bitbucket.org/ws2/repo-b.git", defaultBranch: null },
    ]);

    // Prima chiamata: /2.0/workspaces (NON l'endpoint deprecato repositories?role=member).
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe(WORKSPACES_URL);
    expect(String(firstUrl)).not.toContain("repositories?role=member");
    const headers = (firstInit.headers as Record<string, string>) ?? {};
    // base64("alice@corp.io:api-token")
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`);

    // Le chiamate repo per-workspace usano la stessa identità email:token.
    const repoCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).startsWith("https://api.bitbucket.org/2.0/repositories/ws1"),
    ) as [string, RequestInit];
    expect((repoCall[1].headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("alice@corp.io:api-token").toString("base64")}`,
    );
  });

  it("costruisce il cloneUrl di fallback quando manca il clone https", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === WORKSPACES_URL) {
        return Promise.resolve(jsonOk({ values: [{ slug: "ws1" }] }));
      }
      return Promise.resolve(
        jsonOk({ values: [{ full_name: "ws1/repo-x", name: "repo-x", links: { clone: [] } }] }),
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const repos = await provider.listRepositories(account);
    expect(repos).toEqual([
      { fullName: "ws1/repo-x", name: "repo-x", cloneUrl: "https://bitbucket.org/ws1/repo-x.git", defaultBranch: null },
    ]);
  });

  it("segue `next` nei repo di un workspace ma rispetta il tetto di pagine (~3)", async () => {
    let page = 0;
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === WORKSPACES_URL) {
        return Promise.resolve(jsonOk({ values: [{ slug: "ws1" }] }));
      }
      page++;
      const values = Array.from({ length: 100 }, (_, i) => bbRepo(`ws1/r-${page}-${i}`, "main"));
      return Promise.resolve(
        jsonOk({ values, next: `https://api.bitbucket.org/2.0/repositories/ws1?page=${page + 1}` }),
      );
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const repos = await provider.listRepositories(account);
    expect(repos).toHaveLength(300);
    // 1 chiamata workspaces + 3 chiamate repo (cap MAX_REPO_PAGES).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("segue `next` tra i workspace ma rispetta il tetto di pagine workspace", async () => {
    let wsPage = 0;
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/2.0/workspaces")) {
        wsPage++;
        // Ogni pagina ha 1 workspace e un cursore `next` infinito.
        return Promise.resolve(
          jsonOk({
            values: [{ slug: `ws-${wsPage}` }],
            next: `https://api.bitbucket.org/2.0/workspaces?page=${wsPage + 1}`,
          }),
        );
      }
      return Promise.resolve(jsonOk({ values: [] }));
    });
    const provider = new BitbucketProvider({ fetchImpl });
    await provider.listRepositories(account);
    // Cap workspace = 5 pagine.
    expect(wsPage).toBe(5);
  });

  it("totale repo limitato a ~300 anche con molti workspace", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === WORKSPACES_URL) {
        return Promise.resolve(
          jsonOk({ values: Array.from({ length: 10 }, (_, i) => ({ slug: `ws${i}` })) }),
        );
      }
      // Ogni workspace ha 100 repo su una pagina (no next).
      const slug = url.match(/repositories\/(ws\d+)/)?.[1] ?? "ws";
      const values = Array.from({ length: 100 }, (_, i) => bbRepo(`${slug}/r-${i}`, "main"));
      return Promise.resolve(jsonOk({ values }));
    });
    const provider = new BitbucketProvider({ fetchImpl });
    const repos = await provider.listRepositories(account);
    expect(repos.length).toBeLessThanOrEqual(300);
    expect(repos).toHaveLength(300);
  });

  it("401 sul listing workspace → GitProviderError in italiano", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
    await expect(provider.listRepositories(account)).rejects.toThrow(/autenticazione|401/i);
  });

  it("410 sul listing repo di un workspace → GitProviderError", async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === WORKSPACES_URL) {
        return Promise.resolve(jsonOk({ values: [{ slug: "ws1" }] }));
      }
      return Promise.resolve(new Response("gone", { status: 410 }));
    });
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listRepositories(account)).rejects.toBeInstanceOf(GitProviderError);
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

    const result = await provider.listBranches(account, "myws/repo");
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
    const result = await provider.listBranches(account, "myws/repo");
    expect(result.branches).toHaveLength(200);
  });

  it("401 → GitProviderError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(provider.listBranches(account, "myws/repo")).rejects.toBeInstanceOf(GitProviderError);
  });
});
