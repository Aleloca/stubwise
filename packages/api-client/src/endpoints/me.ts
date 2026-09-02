import { notificationPrefsViewSchema, projectFollowsSchema } from "@stubwise/shared";
import type { NotificationPrefs, NotificationPrefsView, ProjectFollows, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";

/**
 * Preferenze personali dell'utente corrente.
 *
 * Entrambi i PUT SOSTITUISCONO (non sono delta) e rispondono 204: chi salva
 * manda sempre l'insieme completo, e chi legge deve rifare la GET — è la
 * ragione per cui l'onboarding dell'app manda tutti i progetti seguiti in una
 * volta invece di un toggle per volta.
 *
 * NOTA: `/api/me/devices` (registrazione del token push) NON è qui: la rotta
 * arriva con la fase B del programma, insieme al relay.
 */
export function createMeEndpoints(request: ApiRequest) {
  return {
    /** Progetti seguiti: l'insieme COMPLETO. */
    follows(): Promise<Reader<ProjectFollows>> {
      return request("GET", "/api/me/follows", undefined, projectFollowsSchema);
    },

    /** SOSTITUISCE l'insieme dei progetti seguiti: 204. */
    setFollows(projectIds: string[]): Promise<void> {
      return request("PUT", "/api/me/follows", { projectIds });
    },

    /**
     * Preferenze di notifica più il contesto per renderle: senza `slackLinked`
     * il toggle del DM va mostrato disabilitato (acceso, il canale resterebbe
     * muto).
     */
    notificationPrefs(): Promise<Reader<NotificationPrefsView>> {
      return request("GET", "/api/me/notification-prefs", undefined, notificationPrefsViewSchema);
    },

    /** Accende o spegne il DM Slack: 204. L'inbox in-app non è disattivabile. */
    setNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
      return request("PUT", "/api/me/notification-prefs", prefs);
    },
  };
}
