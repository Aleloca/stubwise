import { getMessaging, getToken } from "@react-native-firebase/messaging";
import { Platform } from "react-native";

export interface PushToken {
  platform: "ios" | "android";
  token: string;
}

/** La piattaforma nella forma che `PUT /api/me/devices` accetta (vedi `deviceRegistrationSchema`). */
export function currentPlatform(): "ios" | "android" {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * Il token push del device, letto da `@react-native-firebase/messaging`
 * (FCM, **anche su iOS**: vedi §4 del design doc di fase 4 — il routing è
 * FCM-first su entrambe le piattaforme, non APNs nativo direttamente).
 * `@notifee/react-native` (usato altrove per `requestPermission` e le
 * categorie) non genera token push: è un provider di notifiche/canali, non di
 * FCM/APNs.
 *
 * ⚠️ API MODULARE (`getMessaging()` + `getToken(messaging)`), non quella
 * namespaced `messaging().getToken()` di versioni precedenti del pacchetto:
 * la v26 installata qui NON esporta più un `default` chiamabile — verificato
 * sui `.d.ts` pubblicati, il compat namespace è sparito. `getMessaging()`
 * senza argomenti prende l'app Firebase di default (quella configurata da
 * `GoogleService-Info.plist`/`google-services.json`, vedi README).
 *
 * `null` quando FCM non ha ancora un token da dare (permesso negato, provider
 * non pronto, device senza servizi Google): mandare un token fabbricato
 * scriverebbe una riga morta in `device_tokens` che nessuna push
 * raggiungerebbe mai — meglio non registrare nulla che registrare un valore
 * inventato.
 */
export async function getPushToken(): Promise<PushToken | null> {
  const token = await getToken(getMessaging());
  if (!token) return null;
  return { platform: currentPlatform(), token };
}
