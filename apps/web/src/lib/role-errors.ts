import type { TFunction } from "i18next";
import { ApiError } from "./api";
import { translateApiError } from "./translate-api-error";

/**
 * Gli errori delle azioni su ruoli, membri, utenti e inviti, detti in chiaro.
 *
 * Il server risponde con codici stabili (`role_in_use`, `last_full_admin`,
 * `escalation`…) che `translateApiError` traduce già; qui si aggiungono i dati
 * che quei codici portano nel body:
 *
 * - `role_in_use` porta `count` (quante assegnazioni lo usano);
 * - `escalation` (dare un permesso che non hai) porta `permission`, la chiave
 *   che manca: la si mostra con la sua etichetta. È un 403 con un codice suo
 *   (ruling R44), distinto dal `forbidden` della guardia di rotta, che resta
 *   generico. (`target_above` non esiste più dall'area 9, D-2.)
 */
export function translateRoleError(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { count?: unknown; permission?: unknown };
    if (error.code === "role_in_use" && typeof details.count === "number") {
      return t("errors:role_in_use_count", { count: details.count });
    }
    if (error.code === "escalation") {
      const permission = typeof details.permission === "string" ? details.permission : null;
      return permission
        ? t(`errors:${error.code}_permission`, {
            permission: t(`permissions:label.${permission}`, { defaultValue: permission }),
          })
        : t(`errors:${error.code}`);
    }
  }
  return translateApiError(error, t);
}
