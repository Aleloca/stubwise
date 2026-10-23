import type { TFunction } from "i18next";
import { ApiError } from "../../lib/api";
import { translateApiError } from "../../lib/translate-api-error";

/**
 * Sotto questa soglia di codici di riserva rimasti la web avvisa (design:
 * «≤ 3»). Una sola costante per il login e per Impostazioni → Sicurezza.
 */
export const LOW_BACKUP_CODES_THRESHOLD = 3;

/** Ora (HH:MM, 24 h) di un istante ISO, nel fuso di chi guarda. */
function clockTime(iso: string, language: string): string {
  return new Date(iso).toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** Testo del blocco per troppi codici sbagliati, con l'ora di sblocco. */
export function lockedMessage(lockedUntil: string, t: TFunction, language: string): string {
  return t("auth:secondFactor.locked", { time: clockTime(lockedUntil, language) });
}

/**
 * Traduce l'errore di un tentativo di secondo fattore (codice, codice di
 * riserva o passkey), uguale su ogni porta che passa da `attemptSecondFactor`
 * sul server: il 423 porta in `details` l'ora di sblocco e la si mostra; il
 * resto (`invalid_second_factor`, `second_factor_busy`, …) passa dalle chiavi
 * `errors:<code>`.
 */
export function secondFactorErrorMessage(error: unknown, t: TFunction, language: string): string {
  if (error instanceof ApiError && error.code === "second_factor_locked") {
    const details = error.details as { lockedUntil?: unknown } | undefined;
    if (typeof details?.lockedUntil === "string") {
      return lockedMessage(details.lockedUntil, t, language);
    }
  }
  return translateApiError(error, t);
}
