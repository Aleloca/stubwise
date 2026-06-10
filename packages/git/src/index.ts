import type { GitProviderKind } from "@stubwise/shared";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import type { GitProvider, GitProviderOptions } from "./provider.js";

export * from "./provider.js";
export { BitbucketProvider } from "./bitbucket.js";
export { GitHubProvider } from "./github.js";

export function getProvider(kind: GitProviderKind, options: GitProviderOptions = {}): GitProvider {
  switch (kind) {
    case "bitbucket":
      return new BitbucketProvider(options);
    case "github":
      return new GitHubProvider(options);
    default:
      throw new Error(`Unknown git provider kind: ${String(kind satisfies never)}`);
  }
}
