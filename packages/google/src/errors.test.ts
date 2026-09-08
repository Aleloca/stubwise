import { describe, expect, it } from "vitest";
import { FATAL_GOOGLE_CODES, GoogleApiError, isFatalGoogleError } from "./errors.js";

describe("GoogleApiError", () => {
  it("porta status, code, reason e retryAfterMs", () => {
    const error = new GoogleApiError({
      api: "oauth.token",
      status: 429,
      code: "rate_limited",
      reason: "rateLimitExceeded",
      retryAfterMs: 7000,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GoogleApiError");
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.reason).toBe("rateLimitExceeded");
    expect(error.retryAfterMs).toBe(7000);
    expect(error.message).toContain("oauth.token");
    expect(error.message).toContain("rate_limited");
  });

  it("lascia retryAfterMs indefinito quando l'header non c'era", () => {
    const error = new GoogleApiError({ api: "gmail.messages.list", status: 500, code: "server_error", reason: "backendError" });
    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe("isFatalGoogleError", () => {
  it("è fatale per i quattro codici che disabilitano la casella", () => {
    expect([...FATAL_GOOGLE_CODES].sort()).toEqual([
      "access_denied",
      "insufficient_scope",
      "invalid_grant",
      "unauthorized_client",
    ]);
    for (const code of FATAL_GOOGLE_CODES) {
      expect(isFatalGoogleError(new GoogleApiError({ api: "oauth.token", status: 401, code, reason: code }))).toBe(true);
    }
  });

  it("NON è fatale per i transitori: rete, timeout, 429, 5xx", () => {
    for (const code of ["network_error", "timeout", "rate_limited", "server_error"]) {
      expect(isFatalGoogleError(new GoogleApiError({ api: "gmail.history.list", status: 0, code, reason: code }))).toBe(
        false,
      );
    }
  });

  it("NON è fatale per i sincronismi scaduti: si riparte da un resync, non si disabilita", () => {
    expect(
      isFatalGoogleError(
        new GoogleApiError({ api: "gmail.history.list", status: 404, code: "history_expired", reason: "notFound" }),
      ),
    ).toBe(false);
    expect(
      isFatalGoogleError(
        new GoogleApiError({ api: "calendar.events.list", status: 410, code: "sync_token_expired", reason: "fullSyncRequired" }),
      ),
    ).toBe(false);
  });

  it("NON è fatale per qualunque cosa che non sia un GoogleApiError", () => {
    expect(isFatalGoogleError(new Error("invalid_grant"))).toBe(false);
    expect(isFatalGoogleError("invalid_grant")).toBe(false);
    expect(isFatalGoogleError(null)).toBe(false);
  });
});
