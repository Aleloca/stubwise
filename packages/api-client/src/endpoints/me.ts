import {
  claudeDecisionViewSchema,
  dayArrangementSchema,
  emailChangeStatusSchema,
  meSessionSchema,
  notificationPrefsViewSchema,
  projectFollowsSchema,
} from "@stubwise/shared";
import type {
  ClaudeDecisionView,
  DayArrangement,
  DeviceRegistration,
  EmailChangeStatus,
  MeSession,
  NotificationPrefsUpdate,
  NotificationPrefsView,
  ProjectFollows,
  Reader,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Preferenze personali dell'utente corrente.
 *
 * Le due scritture sulle PREFERENZE hanno semantiche diverse, e il verbo HTTP
 * di ciascuna la dichiara — è la ragione per cui non sono lo stesso verbo:
 *
 *  - `setFollows` SOSTITUISCE l'insieme dei progetti seguiti. Chi salva manda
 *    sempre la lista completa — è la ragione per cui l'onboarding dell'app li
 *    manda tutti insieme invece di un toggle per volta.
 *  - `setNotificationPrefs` è una `PATCH`: si mandano i soli canali da cambiare
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
    /**
     * «Da decidere» di Claude (area 3, fetta 3b): piani e domande che
     * aspettano chi guarda, coi suoi permessi. Si decide con le rotte di
     * sempre (`tickets.approvePlan`/`rejectPlan`, `tickets.answerQuestion`).
     */
    claudeDecisions(): Promise<Reader<ClaudeDecisionView>[]> {
      return request("GET", "/api/me/claude-decisions", undefined, z.array(claudeDecisionViewSchema));
    },
    /**
     * Le mie sistemazioni per giorno in una settimana (`YYYY-Www`, fetta 2):
     * solo delle task ancora mie e ancora in quella settimana.
     */
    dayArrangements(week: string): Promise<Reader<DayArrangement>[]> {
      return request("GET", `/api/me/day-arrangements${toQuery({ week })}`, undefined, z.array(dayArrangementSchema));
    },

    /** Progetti seguiti: l'insieme COMPLETO. */
    follows(): Promise<Reader<ProjectFollows>> {
      return request("GET", "/api/me/follows", undefined, projectFollowsSchema);
    },

    /** SOSTITUISCE l'insieme dei progetti seguiti: 204. */
    setFollows(projectIds: string[]): Promise<void> {
      return request("PUT", "/api/me/follows", { projectIds });
    },

    /** Preferenze di notifica: oggi la sola push (Slack è andato via con R3). */
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
     * Due conseguenze che cambiano come lo si usa: RIATTIVA un device che il
     * server aveva disattivato (quindi ri-registrare al login è la cura di un
     * telefono diventato muto, non un no-op), e il device PASSA all'utente
     * autenticato ORA. Il ragionamento completo sul passaggio — perché serve e
     * cosa costa — sta su `deviceRegistrationSchema` in `@stubwise/shared`.
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
     * ⚠️ `POST` con il token nel BODY, e non un `DELETE` con il token nel
     * path: il server logga l'URL intero di ogni richiesta, quindi nel path il
     * token push finirebbe in chiaro nei log. Il body no. Per la stessa
     * ragione il token va passato GREZZO — nessun `encodeURIComponent`, che
     * qui non proteggerebbe da nulla e produrrebbe un token diverso da quello
     * registrato, cioè una cancellazione che non cancella niente e risponde
     * 204.
     *
     * 204 anche su un token già cancellato o mai registrato: è idempotente
     * apposta, così un ritentativo dopo un timeout di rete non diventa un
     * errore da mostrare a chi sta uscendo.
     */
    deleteDevice(token: string): Promise<void> {
      return request("POST", "/api/me/devices/delete", { token });
    },

    /**
     * Area 9, F1: le mie sessioni (browser, desktop, telefono), con la
     * corrente segnata. `endSession` la chiude: 204; 409 `current_session`
     * sulla corrente, 404 su un id non mio.
     */
    sessions(): Promise<Reader<MeSession>[]> {
      return request("GET", "/api/me/sessions", undefined, z.array(meSessionSchema));
    },
    endSession(id: string): Promise<void> {
      return request("DELETE", `/api/me/sessions/${seg(id)}`);
    },

    /**
     * La foto: il corpo è l'immagine grezza (PNG, JPEG o WebP, al più 512 KB;
     * il tipo lo dicono i byte). 204; 415 `unsupported_image`, 413 oltre il
     * tetto. Passa dal trasporto `request` come corpo binario.
     */
    putAvatar(image: Blob | ArrayBuffer | Uint8Array): Promise<void> {
      return request("PUT", "/api/me/avatar", image);
    },
    deleteAvatar(): Promise<void> {
      return request("DELETE", "/api/me/avatar");
    },

    /**
     * Il cambio della MIA email di login. `available: false` = nessun SMTP
     * sull'istanza. `startEmailChange` (riconferma) manda il link alla nuova:
     * 409 `email_taken` / `email_transport_unavailable`, 502 `email_send_failed`.
     */
    emailChange(): Promise<Reader<EmailChangeStatus>> {
      return request("GET", "/api/me/email-change", undefined, emailChangeStatusSchema);
    },
    startEmailChange(newEmail: string): Promise<Reader<EmailChangeStatus>> {
      return request("POST", "/api/me/email-change", { newEmail }, emailChangeStatusSchema);
    },
    cancelEmailChange(): Promise<void> {
      return request("DELETE", "/api/me/email-change");
    },
  };
}
