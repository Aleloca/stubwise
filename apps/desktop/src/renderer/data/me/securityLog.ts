import type { SecurityEventKind } from "../admin/types";
import { securityAlert } from "../seed/notifications";
import { newId, now, state } from "../store";

// Il registro della sicurezza e l'avviso `security.alert` (area 9a): UN
// posto che li scrive, per l'Amministrazione (reset del secondo fattore, link
// di reset), le Preferenze (passkey, codici, password) e l'ingresso (login,
// blocco). Il registro è solo in aggiunta. L'avviso ignora le preferenze e va
// SOLO all'interessato (`second-factor.md`); non contiene mai un segreto.

/** Una riga del registro della sicurezza; `byId` = chi l'ha fatto, se non la persona stessa. */
export function logSecurity(personId: string, kind: SecurityEventKind, byId: string | null): void {
  state.securityEvents.push({ id: newId("sev"), personId, kind, at: now(), byId });
}

/** Un avviso di sicurezza alla sola persona interessata. */
export function publishSecurityAlert(personId: string, title: string, body: string): void {
  state.securityCodeSeq += 1;
  state.notifications.push(
    securityAlert({
      id: newId("n"),
      code: state.securityCodeSeq,
      personId,
      title,
      body,
      at: now(),
    }),
  );
}
