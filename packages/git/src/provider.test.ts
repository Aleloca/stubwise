import { describe, expect, it } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import {
  assertPageOnApiHost,
  commitWebUrl,
  GitProviderError,
  getProvider,
  isFullCommitSha,
  parsePrNumberFromUrl,
  parseRepoUrl,
  STUBWISE_REVIEW_STATUS_KEY,
} from "./index.js";

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

describe("parsePrNumberFromUrl", () => {
  it("estrae il numero da un URL GitHub", () => {
    expect(parsePrNumberFromUrl("https://github.com/octo/repo/pull/42")).toBe(42);
  });

  it("estrae il numero da un URL Bitbucket", () => {
    expect(parsePrNumberFromUrl("https://bitbucket.org/myws/myrepo/pull-requests/7")).toBe(7);
  });

  it("ignora suffissi dopo il numero (es. #comment)", () => {
    expect(parsePrNumberFromUrl("https://github.com/octo/repo/pull/42#issuecomment-1")).toBe(42);
  });

  it("null su un URL non riconosciuto — mai lancia", () => {
    expect(parsePrNumberFromUrl("https://example.com/not-a-pr")).toBeNull();
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

describe("isFullCommitSha", () => {
  it("accetta solo 40 caratteri esadecimali, maiuscole comprese", () => {
    expect(isFullCommitSha("a".repeat(40))).toBe(true);
    expect(isFullCommitSha("0123456789ABCDEFabcdef0123456789abcdef01")).toBe(true);
  });

  it("rifiuta lo sha abbreviato di Bitbucket e ogni altra cosa", () => {
    // pr_review_jobs.head_sha di Bitbucket è abbreviato (~12 caratteri): lo
    // status di commit vuole lo sha completo, e un abbreviato va fermato
    // PRIMA della richiesta, non scoperto da un 404.
    expect(isFullCommitSha("abc123def456")).toBe(false);
    expect(isFullCommitSha("g".repeat(40))).toBe(false);
    expect(isFullCommitSha("a".repeat(41))).toBe(false);
    expect(isFullCommitSha("")).toBe(false);
  });
});

describe("assertPageOnApiHost", () => {
  const BB = "https://api.bitbucket.org";

  it("accetta una pagina sull'origin dell'API (anche con porta di default e maiuscole)", () => {
    expect(() => assertPageOnApiHost(`${BB}/2.0/repositories/ws?page=2`, BB, "Bitbucket")).not.toThrow();
    expect(() => assertPageOnApiHost("https://API.bitbucket.org:443/2.0/x", BB, "Bitbucket")).not.toThrow();
    // L'origine attesa può arrivare con un percorso: conta solo l'origin.
    expect(() =>
      assertPageOnApiHost(`${BB}/2.0/x`, "https://api.bitbucket.org/2.0", "Bitbucket")
    ).not.toThrow();
  });

  it.each([
    ["host diverso", "https://evil.example/2.0/x"],
    ["sottodominio-trappola", "https://api.bitbucket.org.evil.example/2.0/x"],
    ["userinfo che maschera l'host", "https://api.bitbucket.org@evil.example/2.0/x"],
    ["userinfo sull'host giusto", "https://user:pw@api.bitbucket.org/2.0/x"],
    ["solo username sull'host giusto", "https://user@api.bitbucket.org/2.0/x"],
    ["http invece di https", "http://api.bitbucket.org/2.0/x"],
    ["porta diversa", "https://api.bitbucket.org:8443/2.0/x"],
    ["URL relativo", "/2.0/repositories/ws?page=2"],
    ["URL malformato", "https://"],
    ["stringa vuota", ""],
  ])("%s → GitProviderError", (_label, url) => {
    let error: unknown = null;
    try {
      assertPageOnApiHost(url, BB, "Bitbucket");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).message).toMatch(/^Bitbucket ha indicato una pagina successiva/);
  });

  it("il messaggio mostra l'origin ricevuta, mai percorso, query né userinfo", () => {
    let message = "";
    try {
      assertPageOnApiHost("https://user:s3cret@evil.example/path?token=abc", BB, "Bitbucket");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("https://evil.example");
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("token=abc");
    expect(message).not.toContain("/path");
  });
});

describe("STUBWISE_REVIEW_STATUS_KEY", () => {
  it("è la chiave che le regole del branch rendono obbligatoria: non cambia", () => {
    // Cambiarla orfanerebbe lo status già richiesto dalle regole di branch
    // configurate sui repository: è un contratto verso l'esterno.
    expect(STUBWISE_REVIEW_STATUS_KEY).toBe("stubwise-review");
  });
});
