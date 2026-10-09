import { ApiError, isAgentSessionsUnavailable } from "@stubwise/api-client";
import type { TFunction } from "i18next";

/** Errore di una chiamata alle sessioni degli agenti, in parole (`mobile.agents.errors.*`). */
export function describeAgentSessionError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError) || error.status === 0) return t("mobile.agents.errors.network");
  if (isAgentSessionsUnavailable(error)) return t("mobile.agents.errors.unavailable");
  switch (error.code) {
    case "session_ended":
      return t("mobile.agents.errors.session_ended");
    case "not_interactive":
      return t("mobile.agents.errors.not_interactive");
    case "interrupt_unsupported":
      return t("mobile.agents.errors.interrupt_unsupported");
    case "not_found":
      return t("mobile.agents.errors.not_found");
    case "forbidden":
      return t("mobile.agents.errors.forbidden");
    default:
      return error.status === 403
        ? t("mobile.agents.errors.forbidden")
        : t("mobile.agents.errors.generic");
  }
}
