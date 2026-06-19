import { describe, expect, it } from "vitest";
import { AgentRunError, AgentTimeoutError, type AgentRunResult } from "../agent/runner.js";
import { isLimitError } from "./limit.js";

const result = (output: string, exitCode: number): AgentRunResult => ({ output, exitCode });

describe("isLimitError", () => {
  it("riconosce il limite di ABBONAMENTO (account) dall'output del CLI", () => {
    expect(isLimitError(result("Claude usage limit reached. Try again later.", 1))).toBe(true);
    expect(isLimitError(result("Error: rate limit reached for this account", 1))).toBe(true);
    expect(isLimitError(result("monthly limit exceeded", 1))).toBe(true);
  });

  it("riconosce il limite API (api_key): 429 / rate_limit_error / overloaded", () => {
    expect(isLimitError(result('{"type":"error","error":{"type":"rate_limit_error"}}', 1))).toBe(
      true,
    );
    expect(isLimitError(result("API error 429: Too Many Requests", 1))).toBe(true);
    expect(isLimitError(result('{"error":{"type":"overloaded_error"}}', 1))).toBe(true);
  });

  it("NON scatta su errori generici / fallimenti normali del fix", () => {
    expect(isLimitError(result("TypeError: cannot read property of undefined", 1))).toBe(false);
    expect(isLimitError(result("tests failed: 3 passing, 2 failing", 1))).toBe(false);
    expect(isLimitError(result("the agent produced no changes", 1))).toBe(false);
  });

  it("NON scatta su exit 0 anche se l'output nominasse 'rate limit'", () => {
    // Un successo non è un limite, qualunque cosa dica l'output.
    expect(isLimitError(result("I added a rate limit to the endpoint", 0))).toBe(false);
  });

  it("NON scatta su timeout né su spawn fallito", () => {
    expect(isLimitError(new AgentTimeoutError(120_000, "output parziale"))).toBe(false);
    expect(isLimitError(new AgentRunError("Impossibile eseguire claude: ENOENT"))).toBe(false);
  });

  it("accetta un Error o una stringa generica", () => {
    expect(isLimitError(new Error("rate_limit_error from upstream"))).toBe(true);
    expect(isLimitError(new Error("network unreachable"))).toBe(false);
    expect(isLimitError("usage limit reached")).toBe(true);
    expect(isLimitError("boom")).toBe(false);
  });

  it("è case-insensitive", () => {
    expect(isLimitError(result("USAGE LIMIT REACHED", 1))).toBe(true);
    expect(isLimitError(result("Rate_Limit_Error", 1))).toBe(true);
  });

  it("ignora input non interpretabili (null/undefined/oggetti)", () => {
    expect(isLimitError(null)).toBe(false);
    expect(isLimitError(undefined)).toBe(false);
    expect(isLimitError({ foo: "bar" })).toBe(false);
  });
});
