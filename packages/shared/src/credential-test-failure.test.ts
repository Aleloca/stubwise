import { describe, expect, it } from "vitest";
import { credentialTestFailureOf } from "./credential-test-failure.js";

describe("credentialTestFailureOf", () => {
  it("la rete: DNS, connessione rifiutata, fetch fallita, timeout", () => {
    for (const e of ["getaddrinfo ENOTFOUND api.anthropic.com", "connect ECONNREFUSED 1.2.3.4:443", "TypeError: fetch failed", "Connection error.", "run timed out after 60000 ms"]) {
      expect(credentialTestFailureOf(e), e).toBe("unreachable");
    }
  });
  it("la credenziale: 401, chiave non valida, autenticazione, e la credenziale vince sulla rete", () => {
    for (const e of ['API Error: 401 {"type":"authentication_error"}', "Invalid API key · Please run /login", "403 Forbidden", "401 after ECONNRESET retry", "authentication_error: unauthorized"]) {
      expect(credentialTestFailureOf(e), e).toBe("invalid_credentials");
    }
  });
  it("review del lotto 5 (M-4): la rete vince quando c'è un codice E* o «fetch failed» senza 401/403, anche se il testo nomina OAuth, la scadenza o l'autenticazione", () => {
    for (const e of [
      "OAuth token refresh failed: getaddrinfo ENOTFOUND console.anthropic.com",
      "request to https://api.anthropic.com failed, reason: certificate has expired",
      "authentication request failed: read ECONNRESET",
      "TypeError: fetch failed (OAuth)",
    ]) {
      expect(credentialTestFailureOf(e), e).toBe("unreachable");
    }
  });
  it("niente di riconoscibile, o nessun testo: credenziale, come prima", () => {
    expect(credentialTestFailureOf("exit code 1")).toBe("invalid_credentials");
    expect(credentialTestFailureOf(null)).toBe("invalid_credentials");
  });
});
