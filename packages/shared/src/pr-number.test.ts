import { describe, expect, it } from "vitest";
import { prNumberFromUrl } from "./index.js";

describe("prNumberFromUrl", () => {
  it.each<[string, number | null]>([
    ["https://github.com/octo/repo/pull/42", 42],
    ["https://bitbucket.org/ws/repo/pull-requests/7", 7],
    ["https://api.github.com/repos/octo/repo/pulls/13", 13],
    ["https://github.com/octo/repo/pull/42#issuecomment-1", 42],
    ["https://github.com/octo/repo/pull/42?diff=split", 42],
    ["https://bitbucket.org/ws/repo/pull-requests/7/diff", 7],
    ["https://github.com/octo/repo/pull/abc", null],
    ["https://example.com/not-a-pr", null],
    ["", null],
    // oltre Number.MAX_SAFE_INTEGER: mai un numero arrotondato
    ["https://github.com/octo/repo/pull/99999999999999999999", null],
  ])("%s → %s", (url, atteso) => {
    expect(prNumberFromUrl(url)).toBe(atteso);
  });
});
