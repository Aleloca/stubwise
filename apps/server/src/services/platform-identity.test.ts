import { BitbucketProvider, GitHubProvider } from "@stubwise/git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlatformIdentity } from "./platform-identity.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchPlatformIdentity", () => {
  it("chiede l'identità al provider dell'account, con le sole credenziali", async () => {
    const github = vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockResolvedValue("4242");
    const bitbucket = vi
      .spyOn(BitbucketProvider.prototype, "getAuthenticatedUserId")
      .mockResolvedValue("{uuid-bb}");
    const credentials = { username: "bot", token: "segreto" };

    await expect(fetchPlatformIdentity({ provider: "github", credentials })).resolves.toBe("4242");
    // Con 5 s al massimo: il webhook ne fa più d'una prima dei 10 s di GitHub.
    expect(github).toHaveBeenCalledWith({ credentials }, { timeoutMs: 5_000 });
    expect(bitbucket).not.toHaveBeenCalled();

    await expect(fetchPlatformIdentity({ provider: "bitbucket", credentials })).resolves.toBe("{uuid-bb}");
    expect(bitbucket).toHaveBeenCalledWith({ credentials }, { timeoutMs: 5_000 });
    expect(github).toHaveBeenCalledTimes(1);
  });

  it("l'errore del provider risale com'è (resolveProviderUserId lo trasforma in null)", async () => {
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("HTTP 401"));
    await expect(
      fetchPlatformIdentity({ provider: "github", credentials: { token: "segreto" } }),
    ).rejects.toThrow("HTTP 401");
  });
});
