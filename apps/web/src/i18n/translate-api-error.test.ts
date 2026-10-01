import type { TFunction } from "i18next";
import { afterEach, describe, expect, it as test } from "vitest";
import { ApiError } from "../lib/api";
import { translateApiError } from "../lib/translate-api-error";
import i18n from "./index";

const t = i18n.t.bind(i18n) as TFunction;

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("translateApiError", () => {
  test("traduce un code noto nella lingua attiva (en)", () => {
    const error = new ApiError(404, "Ticket not found", "ticket_not_found");
    expect(translateApiError(error, t)).toBe("Ticket not found");
  });

  test("traduce un code noto nella lingua attiva (it)", async () => {
    await i18n.changeLanguage("it");
    const error = new ApiError(404, "Ticket not found", "ticket_not_found");
    expect(translateApiError(error, t)).toBe("Ticket non trovato");
  });

  test("fa fallback sul message del server per un code sconosciuto", () => {
    const error = new ApiError(400, "Some upstream message", "totally_unknown_code");
    expect(translateApiError(error, t)).toBe("Some upstream message");
  });

  test("fa fallback sul message quando manca del tutto il code", () => {
    const error = new ApiError(500, "Internal error");
    expect(translateApiError(error, t)).toBe("Internal error");
  });

  test("usa un messaggio generico per errori non-API senza message", () => {
    expect(translateApiError({}, t)).toBe("Something went wrong");
  });
});

/**
 * I codici d'errore del ciclo di correzione post-PR e dell'account revisore:
 * ognuno deve avere un testo PROPRIO in entrambe le lingue, raggiungibile da
 * `translateApiError` (che altrimenti ripiega sul `message` grezzo del server,
 * in inglese o — per `review_account_no_write_permission` — in italiano).
 * Il messaggio grezzo qui è una sentinella: se torna quella, la chiave manca.
 */
// Aggiorna questa lista quando una rotta del ciclo aggiunge un codice.
const CORRECTION_CODES = [
  // POST /api/tickets/:id/repositories/:repositoryId/corrections
  "pr_not_found",
  "correction_in_flight",
  "job_in_flight",
  "pr_not_open",
  "not_stubwise_pr",
  // POST /api/tickets/:id/run-ai con resumeCorrectionJobId
  "correction_not_held",
  "needs_maintainer",
  // POST/PATCH /api/repositories (account revisore)
  "review_account_no_write_permission",
  "review_credentials_undecryptable",
  "repository_changed_concurrently",
  "main_account_identity_unresolved",
  "review_account_same_identity",
  "review_account_invalid",
  "review_account_same_as_main",
  "review_account_provider_mismatch",
  "review_account_workspace_mismatch",
  "review_account_identity_unresolved",
  "review_git_account_not_found",
  "repository_not_found",
  // PUT /api/git-accounts/:id/default-reviewer e PATCH /api/git-accounts/:id
  // (revisore predefinito)
  "default_reviewer_conflict",
  "default_reviewer_account_changed",
  "default_reviewer_workspace_locked",
  "default_reviewer_workspace_missing",
  "default_reviewer_invalid",
] as const;

describe("translateApiError — codici del ciclo di correzione e dell'account revisore", () => {
  const RAW = "__raw server message__";

  for (const lang of ["en", "it"] as const) {
    for (const code of CORRECTION_CODES) {
      test(`${lang}: ${code} ha un testo proprio, non il messaggio grezzo`, async () => {
        await i18n.changeLanguage(lang);
        const out = translateApiError(new ApiError(409, RAW, code), t);
        expect(out).not.toBe(RAW);
        expect(out.trim()).not.toBe("");
      });
    }
  }

  test("en e it dicono cose diverse (nessun codice lasciato in inglese)", async () => {
    for (const code of CORRECTION_CODES) {
      await i18n.changeLanguage("en");
      const en = translateApiError(new ApiError(409, RAW, code), t);
      await i18n.changeLanguage("it");
      const it = translateApiError(new ApiError(409, RAW, code), t);
      expect(it, code).not.toBe(en);
    }
  });

  test("review_account_invalid conserva il dettaglio del provider dentro il testo tradotto", async () => {
    await i18n.changeLanguage("it");
    const detail = "Pull requests: 403 Forbidden";
    const out = translateApiError(new ApiError(422, detail, "review_account_invalid"), t);
    expect(out).not.toBe(detail);
    expect(out).toContain(detail);
  });

  test("default_reviewer_invalid conserva i dettagli dei check falliti dentro il testo tradotto", async () => {
    await i18n.changeLanguage("it");
    const detail = "Scope del token: manca write:pullrequest:bitbucket";
    const out = translateApiError(new ApiError(422, detail, "default_reviewer_invalid"), t);
    expect(out).not.toBe(detail);
    expect(out).toContain(detail);
  });
});
