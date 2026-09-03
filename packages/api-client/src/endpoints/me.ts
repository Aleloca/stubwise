import { notificationPrefsViewSchema, projectFollowsSchema } from "@stubwise/shared";
import type {
  DeviceRegistration,
  NotificationPrefsUpdate,
  NotificationPrefsView,
  ProjectFollows,
  Reader,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";

/**
 * Preferenze personali dell'utente corrente.
 *
 * Le due SCRITTURE sulle preferenze NON hanno la stessa semantica, e
 * confonderle si paga — «i due PUT» non è più il modo di nominarle, perché una
 * delle due è una PATCH e `registerDevice` è ora un terzo PUT:
 *
 *  - `setFollows` SOSTITUISCE l'insieme dei progetti seguiti. Chi salva manda
 *    sempre la lista completa — è la ragione per cui l'onboarding dell'app li
 *    manda tutti insieme invece di un toggle per volta.
 *  - `setNotificationPrefs` è una `PATCH` (anche nel verbo HTTP, non solo
 *    nella semantica): si mandano i soli canali da cambiare
 *    e gli assenti restano come sono. Mandare l'insieme completo funziona, ma
 *    vanifica il motivo per cui è una patch — una versione vecchia dell'app,
 *    che non conosce un canale aggiunto dopo, non deve poterlo spegnere per il
 *    fatto di non averlo nel body. Perciò si manda il solo campo toccato.
 *
 * Rispondono 204 tutte, quindi chi legge deve rifare la GET.
 *
 * `registerDevice`/`deleteDevice` sono l'altra metà della push: la preferenza
 * dice SE mandarla, il device dice DOVE. Non hanno un equivalente sul web —
 * un token push ce l'ha solo l'app — e infatti la SPA non li chiama.
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
      return request("PATCH", "/api/me/notification-prefs", patch);
    },

    /**
     * REGISTRA il token push di questo device: 204. È un UPSERT idempotente
     * sul `token`, quindi va chiamato a ogni avvio dell'app e a ogni rotazione
     * del token del sistema operativo, senza tenere traccia di "l'ho già
     * fatto".
     *
     * Due comportamenti da conoscere prima di usarlo:
     *
     *  - RIATTIVA un device che il server aveva disattivato (revoca del PAT,
     *    token rifiutato dal relay). È per questo che ri-registrare al login è
     *    la cura di un telefono diventato muto, e non un no-op.
     *  - Il device PASSA all'utente autenticato ORA. Su un telefono dove A
     *    esce e B entra il token è lo stesso, e senza il passaggio B non
     *    riceverebbe mai una push.
     *
     * Va chiamato con l'autenticazione a PAT (il login mobile): il server lega
     * il device a QUEL token, così revocarlo dalla lista dei token spegne
     * anche le push di quel telefono. Chiamandolo col cookie di sessione la
     * registrazione riesce lo stesso, ma senza quel legame.
     */
    registerDevice(device: DeviceRegistration): Promise<void> {
      return request("PUT", "/api/me/devices", device);
    },

    /**
     * Cancella la registrazione di questo device: 204. È il logout dell'app —
     * la riga viene ELIMINATA, non disattivata.
     *
     * 204 anche su un token già cancellato o mai registrato: è idempotente
     * apposta, così un ritentativo dopo un timeout di rete non diventa un
     * errore da mostrare a chi sta uscendo.
     */
    deleteDevice(token: string): Promise<void> {
      return request("DELETE", `/api/me/devices/${encodeURIComponent(token)}`);
    },
  };
}
