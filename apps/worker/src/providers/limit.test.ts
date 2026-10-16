import { describe, expect, it } from "vitest";
import { AgentRunError, AgentTimeoutError, type AgentRunResult } from "../agent/runner.js";
import { ProviderLimitError, isLimitError, limitResetAt } from "./limit.js";

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

describe("limiti dell'abbonamento (testi veri del 13-15 ott 2026)", () => {
  const exit1 = (output: string) => ({ exitCode: 1, output }) as never;
  it("riconosce «hit your session limit» e «hit your weekly limit»", () => {
    expect(isLimitError(exit1("You've hit your session limit · resets 6pm (UTC)"))).toBe(true);
    expect(isLimitError(exit1("You've hit your weekly limit · resets Oct 14, 1pm (UTC)"))).toBe(true);
  });
  it("un exit 0 che cita il limite non è un limite", () => {
    expect(isLimitError({ exitCode: 0, output: "You've hit your session limit" } as never)).toBe(false);
  });
  it("un fallimento qualunque non è un limite", () => {
    expect(isLimitError(exit1("Error: test failed"))).toBe(false);
  });
  it("un ProviderLimitError lanciato è un limite", () => {
    expect(isLimitError(new ProviderLimitError("qualunque output"))).toBe(true);
  });
});

describe("limitResetAt", () => {
  const now = new Date("2026-10-15T14:00:00Z");
  it("solo l'ora: oggi se è futura", () => {
    expect(limitResetAt("You've hit your session limit · resets 6pm (UTC)", now)?.toISOString()).toBe("2026-10-15T18:00:00.000Z");
  });
  it("solo l'ora già passata: domani", () => {
    expect(limitResetAt("resets 1pm (UTC)", now)?.toISOString()).toBe("2026-10-16T13:00:00.000Z");
  });
  it("con data e minuti", () => {
    expect(limitResetAt("You've hit your weekly limit · resets Oct 14, 1:30pm (UTC)", new Date("2026-10-13T10:00:00Z"))?.toISOString())
      .toBe("2026-10-14T13:30:00.000Z");
  });
  it("data a fine anno: l'anno dopo se il mese è già passato", () => {
    expect(limitResetAt("resets Jan 2, 9am (UTC)", new Date("2026-12-30T10:00:00Z"))?.toISOString()).toBe("2027-01-02T09:00:00.000Z");
  });
  it("data vecchia nel testo: mai oltre 7 giorni da adesso", () => {
    const n = new Date("2026-10-16T10:00:00Z");
    // «Oct 1» è passato da più di un giorno → l'anno dopo (~350 giorni): clamp.
    expect(limitResetAt("resets Oct 1, 9am (UTC)", n)?.toISOString()).toBe("2026-10-23T10:00:00.000Z");
    // Un reset entro la settimana non viene toccato.
    expect(limitResetAt("resets Oct 20, 9am (UTC)", n)?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });
  it("testo senza reset riconoscibile: null", () => {
    expect(limitResetAt("You've hit your session limit", now)).toBeNull();
  });
});
