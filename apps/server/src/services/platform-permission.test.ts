import { randomBytes } from "node:crypto";
import { encrypt } from "@stubwise/db";
import { BitbucketProvider, GitHubProvider, GitProviderError, type ProjectGitConfig } from "@stubwise/git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorPermissionFetcher } from "./platform-permission.js";

/**
 * Il fetcher del permesso reale (E3): pigro, col token dell'account
 * PRINCIPALE, e ogni errore LANCIA (→ `unverifiable`) dopo una riga di log che
 * non contiene mai il token.
 */

const KEY = randomBytes(32);
const TOKEN = "tok-segretissimo-principale";
const account = {
  id: "acc-1",
  encryptedCredentials: encrypt(JSON.stringify({ username: "bot", token: TOKEN }), KEY),
};
const input = { repoUrl: "https://github.com/acme/repo", defaultBranch: "main", account };

function fakeLog() {
  const calls: unknown[][] = [];
  return { calls, log: { warn: (...args: unknown[]) => void calls.push(args) } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorPermissionFetcher", () => {
  it("chiede il permesso col token del principale, sulla repository della PR", async () => {
    const spy = vi.spyOn(GitHubProvider.prototype, "getCollaboratorPermission").mockResolvedValue("write");
    const { log } = fakeLog();

    const fetch = authorPermissionFetcher({ provider: "github", encryptionKey: KEY, log }, input);
    await expect(fetch("mario")).resolves.toBe("write");

    const [p, login, opts] = spy.mock.calls[0]! as [ProjectGitConfig, string, { timeoutMs?: number }];
    expect(login).toBe("mario");
    // Con 5 s al massimo: il webhook ne fa più d'una prima dei 10 s di GitHub.
    expect(opts).toEqual({ timeoutMs: 5_000 });
    expect(p.repoUrl).toBe("https://github.com/acme/repo");
    expect(p.credentials.token).toBe(TOKEN);
  });

  it("pigro: costruirlo non chiama il provider", () => {
    const spy = vi.spyOn(GitHubProvider.prototype, "getCollaboratorPermission").mockResolvedValue("write");
    const { log } = fakeLog();
    authorPermissionFetcher({ provider: "github", encryptionKey: KEY, log }, input);
    expect(spy).not.toHaveBeenCalled();
  });

  it("errore del provider: lancia, e il log ha il messaggio ma MAI il token", async () => {
    vi.spyOn(GitHubProvider.prototype, "getCollaboratorPermission").mockRejectedValue(
      new GitProviderError("GitHub: accesso negato (403)", 403, ""),
    );
    const { log, calls } = fakeLog();

    const fetch = authorPermissionFetcher({ provider: "github", encryptionKey: KEY, log }, input);
    await expect(fetch("mario")).rejects.toThrow("403");

    expect(calls).toHaveLength(1);
    const logged = JSON.stringify(calls);
    expect(logged).toContain("accesso negato");
    expect(logged).not.toContain(TOKEN);
  });

  it("credenziali non decifrabili: lancia senza chiamare il provider", async () => {
    const spy = vi.spyOn(GitHubProvider.prototype, "getCollaboratorPermission").mockResolvedValue("admin");
    const { log } = fakeLog();

    const fetch = authorPermissionFetcher(
      { provider: "github", encryptionKey: randomBytes(32), log },
      input,
    );
    await expect(fetch("mario")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("provider senza il metodo (Bitbucket): lancia, mai un permesso inventato", async () => {
    expect(BitbucketProvider.prototype).not.toHaveProperty("getCollaboratorPermission");
    const { log } = fakeLog();

    const fetch = authorPermissionFetcher({ provider: "bitbucket", encryptionKey: KEY, log }, input);
    await expect(fetch("mario")).rejects.toThrow();
  });
});
