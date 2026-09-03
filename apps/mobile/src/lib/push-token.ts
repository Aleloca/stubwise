export interface PushToken {
  platform: "ios" | "android";
  token: string;
}

/**
 * Seam del provider del push token — NON ancora cablato.
 *
 * Il Task 19 lo sostituirà con la lettura vera da
 * `@react-native-firebase/messaging` (FCM, anche su iOS: vedi §4 del design
 * doc di fase 4). `@notifee/react-native` — che questo task USA per
 * `requestPermission` — non genera token push: è un provider di
 * notifiche/canali, non di FCM/APNs.
 *
 * Ritorna sempre `null` qui: senza un provider cablato non esiste un token
 * vero da mandare a `PUT /api/me/devices`, e mandarne uno fabbricato
 * scriverebbe una riga morta in `device_tokens` (nessuna push potrà mai
 * raggiungerla) che l'upsert per-token del Task 19 non "ripulirebbe" da sé —
 * resterebbe lì come riga orfana. L'onboarding (`OnboardingScreen`) chiama
 * comunque `notifee.requestPermission()`: il permesso di sistema si chiede
 * una volta sola, e conviene chiederlo ora così il Task 19 lo trova già
 * concesso.
 */
// Firma già `async` (anche se oggi non c'è nulla da attendere): il Task 19
// la implementerà con `messaging().getToken()`, che è asincrono — i
// chiamanti (OnboardingScreen) già fanno `await getPushToken()`.
export function getPushToken(): Promise<PushToken | null> {
  return Promise.resolve(null);
}
