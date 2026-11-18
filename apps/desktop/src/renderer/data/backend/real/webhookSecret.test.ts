import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { webhookSecretOutcome, webhookSecretRefusal } from "./webhookSecret";

// Area 9, F5: la rigenerazione del segreto del webhook git (72, 7da256def,
// 0f8a80bba) nel risultato della pagina. Il segreto esce una volta.

describe("il segreto del webhook rigenerato", () => {
  it("manual e platform: il segreto e dove va", () => {
    expect(webhookSecretOutcome({ mode: "manual", webhookSecret: "s3cr3t" })).toEqual({
      ok: true,
      secret: "s3cr3t",
      mode: "manual",
    });
    expect(webhookSecretOutcome({ mode: "platform", webhookSecret: "s3cr3t" })).toEqual({
      ok: true,
      secret: "s3cr3t",
      mode: "platform",
    });
  });

  it("rollback: resta il vecchio; diviso se la piattaforma non è tornata indietro", () => {
    expect(webhookSecretOutcome({ mode: "rollback", platformRestored: true })).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_rollback",
    });
    expect(webhookSecretOutcome({ mode: "rollback", platformRestored: false })).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_split",
    });
  });

  it("un modo che l'app non conosce, o senza segreto, non si mostra come riuscito", () => {
    expect(webhookSecretOutcome({ mode: "__unknown__", webhookSecret: "x" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_unknown",
    });
    expect(webhookSecretOutcome({ mode: "manual" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_unknown",
    });
  });

  it("i rifiuti del server col loro codice", () => {
    expect(webhookSecretRefusal(new ApiError(422, "scope", "webhook_scope_missing"))).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_scope_missing",
    });
    expect(webhookSecretRefusal(new ApiError(502, "no", "platform_update_failed"))).toEqual({
      ok: false,
      error: "invalid",
      reason: "platform_update_failed",
    });
    expect(webhookSecretRefusal(new ApiError(403, "r", "reauth_required"))).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(webhookSecretRefusal(new ApiError(403, "f", "forbidden"))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(webhookSecretRefusal(new ApiError(404, "n", "not_found"))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(() => webhookSecretRefusal(new Error("rete"))).toThrow("rete");
  });
});
