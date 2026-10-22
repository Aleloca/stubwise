import type { TFunction } from "i18next";
import { ApiError } from "./api";
import { translateApiError } from "./translate-api-error";

/**
 * Gli errori delle azioni su ruoli, membri e inviti, detti in chiaro.
 *
 * Il server risponde con codici stabili (`role_in_use`, `last_full_admin`,
 * `role_required_by_system`…) che `translateApiError` traduce già; qui si
 * aggiungono i due casi che quel codice da solo non distingue:
 *
 * - `role_in_use` porta `count` nel body (quante assegnazioni lo usano);
 * - un 403 `forbidden` di queste rotte è l'anti-escalation («non puoi dare un
 *   permesso che non hai») o la protezione del bersaglio («non puoi toccare
 *   chi ha più permessi di te»): il server nomina la chiave fra parentesi nel
 *   `message`, e la si mostra con la sua etichetta. Un 403 di altro tipo
 *   (permesso della rotta mancante) resta il messaggio generico.
 */
export function translateRoleError(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (error.code === "role_in_use") {
      const count = (error.details as { count?: unknown } | undefined)?.count;
      if (typeof count === "number") return t("errors:role_in_use_count", { count });
    }
    if (error.code === "forbidden") {
      const permission = /\(([a-z_.]+)\)$/.exec(error.message)?.[1];
      if (permission) {
        const label = t(`permissions:label.${permission}`, { defaultValue: permission });
        if (error.message.startsWith("You cannot grant")) {
          return t("errors:role_escalation", { permission: label });
        }
        if (error.message.startsWith("You cannot change a role")) {
          return t("errors:role_target_above", { permission: label });
        }
      }
    }
  }
  return translateApiError(error, t);
}
