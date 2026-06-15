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
