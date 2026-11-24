import { describe, expect, it } from "vitest";
import { credentialTestFailureOf } from "./credential-test-failure.js";

describe("credentialTestFailureOf", () => {
  it("la rete: DNS, connessione rifiutata, fetch fallita, timeout", () => {
    for (const e of ["getaddrinfo ENOTFOUND api.anthropic.com", "connect ECONNREFUSED 1.2.3.4:443", "TypeError: fetch failed", "Connection error.", "run timed out after 60000 ms"]) {
      expect(credentialTestFailureOf(e), e).toBe("unreachable");
    }
  });
  it("la credenziale: 401, chiave non valida, autenticazione, e la credenziale vince sulla rete", () => {
    for (const e of ['API Error: 401 {"type":"authentication_error"}', "Invalid API key · Please run /login", "OAuth token has expired", "403 Forbidden", "authentication failed after ECONNRESET retry"]) {
      expect(credentialTestFailureOf(e), e).toBe("invalid_credentials");
    }
  });
  it("niente di riconoscibile, o nessun testo: credenziale, come prima", () => {
    expect(credentialTestFailureOf("exit code 1")).toBe("invalid_credentials");
    expect(credentialTestFailureOf(null)).toBe("invalid_credentials");
  });
});
