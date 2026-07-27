import { describe, expect, it } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import { commitWebUrl, getProvider, parseRepoUrl } from "./index.js";

describe("getProvider", () => {
  it("returns the Bitbucket implementation for 'bitbucket'", () => {
    expect(getProvider("bitbucket")).toBeInstanceOf(BitbucketProvider);
  });

  it("returns the GitHub implementation for 'github'", () => {
    expect(getProvider("github")).toBeInstanceOf(GitHubProvider);
  });

  it("throws on unknown provider kinds", () => {
    expect(() => getProvider("gitlab" as never)).toThrow(/gitlab/);
  });
});

describe("parseRepoUrl", () => {
  it("extracts host, owner and repo slug", () => {
    expect(parseRepoUrl("https://github.com/octo/repo")).toEqual({
      host: "github.com",
      owner: "octo",
      repo: "repo",
    });
  });

  it("strips trailing .git and trailing slash", () => {
    expect(parseRepoUrl("https://bitbucket.org/ws/slug.git")).toEqual({
      host: "bitbucket.org",
      owner: "ws",
      repo: "slug",
    });
    expect(parseRepoUrl("https://bitbucket.org/ws/slug/")).toEqual({
      host: "bitbucket.org",
      owner: "ws",
      repo: "slug",
    });
  });

  it("throws a clear error on unparsable URLs", () => {
    expect(() => parseRepoUrl("not a url")).toThrow(/repo url/i);
    expect(() => parseRepoUrl("https://github.com/")).toThrow(/repo url/i);
    expect(() => parseRepoUrl("https://github.com/just-owner")).toThrow(/repo url/i);
    expect(() => parseRepoUrl("https://github.com/a/b/c")).toThrow(/repo url/i);
  });

  it("rejects ssh:// URLs (https only)", () => {
    expect(() => parseRepoUrl("ssh://git@github.com/octo/repo")).toThrow(/https/i);
  });

  it("rejects http:// URLs (https only)", () => {
    expect(() => parseRepoUrl("http://github.com/octo/repo")).toThrow(/https/i);
  });

  it("drops credentials embedded in the repoUrl", () => {
    expect(parseRepoUrl("https://user:secret@github.com/octo/repo")).toEqual({
      host: "github.com",
      owner: "octo",
      repo: "repo",
    });
  });
});

describe("commitWebUrl", () => {
  it("costruisce l'URL del commit per GitHub (/commit/) e Bitbucket (/commits/)", () => {
    expect(commitWebUrl("github", "https://github.com/acme/api.git", "abc1234")).toBe(
      "https://github.com/acme/api/commit/abc1234",
    );
    expect(commitWebUrl("bitbucket", "https://bitbucket.org/acme/api", "abc1234")).toBe(
      "https://bitbucket.org/acme/api/commits/abc1234",
    );
  });

  it("host self-hosted preservato", () => {
    expect(commitWebUrl("github", "https://git.example.com/acme/api", "deadbee")).toBe(
      "https://git.example.com/acme/api/commit/deadbee",
    );
  });

  it("repoUrl non parsabile o sha vuoto → null (la UI mostra il solo sha)", () => {
    expect(commitWebUrl("github", "git@github.com:acme/api.git", "abc1234")).toBeNull();
    expect(commitWebUrl("github", "https://github.com/acme/api", "")).toBeNull();
  });
});
