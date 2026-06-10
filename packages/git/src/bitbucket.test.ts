import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitProviderError, type ProjectGitConfig } from "./provider.js";

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

  it("throws when username is missing", async () => {
    const fetchImpl = vi.fn();
    const provider = new BitbucketProvider({ fetchImpl });
    await expect(
      provider.openPullRequest(
        { ...config, credentials: { token: "t" } },
        { branch: "b", title: "t", body: "b" }
      )
    ).rejects.toThrow(/username/i);
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
