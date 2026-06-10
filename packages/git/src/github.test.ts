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
