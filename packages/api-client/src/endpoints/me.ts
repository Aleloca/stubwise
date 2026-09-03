import { notificationPrefsViewSchema, projectFollowsSchema } from "@stubwise/shared";
import type {
  NotificationPrefsUpdate,
  NotificationPrefsView,
  ProjectFollows,
  Reader,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";

/**
 * Preferenze personali dell'utente corrente.
 *
 * I due PUT NON hanno la stessa semantica, e confonderle si paga:
 *
 *  - `setFollows` SOSTITUISCE l'insieme dei progetti seguiti. Chi salva manda
 *    sempre la lista completa — è la ragione per cui l'onboarding dell'app li
 *    manda tutti insieme invece di un toggle per volta.
 *  - `setNotificationPrefs` è una PATCH: si mandano i soli canali da cambiare
 *    e gli assenti restano come sono. Mandare l'insieme completo funziona, ma
 *    vanifica il motivo per cui è una patch — una versione vecchia dell'app,
 *    che non conosce un canale aggiunto dopo, non deve poterlo spegnere per il
 *    fatto di non averlo nel body. Perciò si manda il solo campo toccato.
 *
 * Entrambi rispondono 204, quindi chi legge deve rifare la GET.
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

    /**
     * PATCH dei canali opzionali (DM Slack, push sui device): 204. Si mandano
     * i soli campi da cambiare. Il body è STRICT: un campo sconosciuto è 400,
     * non un 204 che nasconde un typo. L'inbox in-app non è disattivabile.
     */
    setNotificationPrefs(patch: NotificationPrefsUpdate): Promise<void> {
      return request("PUT", "/api/me/notification-prefs", patch);
    },
  };
}
