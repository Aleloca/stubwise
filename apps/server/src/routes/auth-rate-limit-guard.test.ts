import { describe, expect, it } from "vitest";
import { credentialsBucketViolation } from "./auth.js";

/**
 * La guardia che tiene UNO solo il tetto di tentativi sulla superficie
 * credenziali. L'hook `onRoute` di `authRoutes` la chiama a ogni rotta e fa
 * fallire l'avvio: qui si esercita il predicato da solo, senza dover
 * registrare una rotta finta dentro il plugin.
 */
describe("credentialsBucketViolation", () => {
  it("blocca una rotta di auth che dichiara config.rateLimit", () => {
    const problem = credentialsBucketViolation("/api/auth/magic-link", {
      rateLimit: { max: 10, timeWindow: "1 minute" },
    });
    expect(problem).toContain("/api/auth/magic-link");
    expect(problem).toContain("credentialsRateLimit");
  });

  it("lascia passare /register, che ha legittimamente il suo bucket", () => {
    expect(
      credentialsBucketViolation("/api/auth/register", {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      }),
    ).toBeNull();
  });

  it("lascia passare una rotta senza rate limit dichiarato", () => {
    expect(credentialsBucketViolation("/api/auth/me", undefined)).toBeNull();
    expect(credentialsBucketViolation("/api/auth/me", {})).toBeNull();
  });

  it("`rateLimit: false` non è una violazione: non apre nessun bucket", () => {
    expect(credentialsBucketViolation("/api/auth/logout", { rateLimit: false })).toBeNull();
  });

  it("il confronto è per suffisso: regge un prefisso di registrazione diverso", () => {
    expect(credentialsBucketViolation("/altro/prefisso/register", { rateLimit: {} })).toBeNull();
    expect(credentialsBucketViolation("/altro/prefisso/login", { rateLimit: {} })).not.toBeNull();
  });
});
