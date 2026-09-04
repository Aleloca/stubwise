/**
 * @format
 */

import { AppRegistry } from "react-native";
import { getMessaging, setBackgroundMessageHandler } from "@react-native-firebase/messaging";
import notifee, { EventType } from "@notifee/react-native";
import App from "./src/app/App";
import { name as appName } from "./app.json";
import { createClientFromSession } from "./src/lib/client";
import { handlePushAction } from "./src/lib/push-actions";

/**
 * Gli handler BACKGROUND (Task 19) vanno registrati QUI — a livello di
 * MODULO, fuori da qualunque componente React — perché sia `notifee` sia
 * `@react-native-firebase/messaging` li richiedono così: registrati dentro
 * `AppProviders`/`App.tsx` non partirebbero mai quando l'app è in
 * background o terminata (il SO rilancia l'entry point JS SENZA montare
 * l'albero React per gestire un evento in background — è tutto il senso di
 * "background"). `lib/push.ts` (`setupPush`) copre invece il PRIMO PIANO,
 * dove l'albero React esiste ed è già montato.
 *
 * Nessun `useAuth()`/contesto React disponibile qui: il client si costruisce
 * da sé dalla sessione salvata nel Keychain (`createClientFromSession`,
 * `lib/client.ts`) — la STESSA funzione che il resto dell'app userebbe per
 * "il client di chi è loggato ORA", solo chiamata fuori da un componente.
 * `null` (nessuna sessione: logout, o notifica arrivata dopo un logout su
 * questo device) degrada a "non faccio nulla" — non c'è un utente per cui
 * eseguire l'azione.
 */
async function handleBackgroundNotificationEvent(type, detail) {
  if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
  const data = detail.notification?.data;
  const notificationId = data && typeof data["notificationId"] === "string" ? data["notificationId"] : undefined;
  const kind = data && typeof data["kind"] === "string" ? data["kind"] : undefined;
  if (!notificationId || !kind) return;

  const client = await createClientFromSession();
  if (!client) return;

  const actionId = type === EventType.ACTION_PRESS ? (detail.pressAction?.id ?? "open") : "open";
  await handlePushAction({ notificationId, kind, actionId }, client);
}

/**
 * Messaggio FCM ricevuto mentre l'app è in background/terminata.
 *
 * ⚠️ **Limite noto di v1, non un bug qui**: il payload che il relay manda
 * (`packages/notifications/src/push/payload.ts`) è un messaggio CON
 * `notification` (non data-only), quindi Android/iOS lo mostrano DA SOLI,
 * senza eseguire codice JS — questo handler in pratica non viene invocato
 * per le nostre push in background (è il comportamento documentato di FCM
 * per i messaggi "notification"). Resta registrato perché
 * `@react-native-firebase/messaging` lo richiede comunque a livello di
 * modulo (altrimenti l'app va in crash all'avvio con un errore "a headless
 * task must be registered"), ed è già pronto per il giorno in cui i
 * messaggi diventassero data-only.
 */
setBackgroundMessageHandler(getMessaging(), async () => {});

/**
 * Pressioni sui bottoni/sul corpo di una notifica mentre l'app è in
 * background o viene RIAPERTA da lì (`EventType.PRESS`/`ACTION_PRESS`) — è
 * il gemello di `notifee.onForegroundEvent` in `lib/push.ts`, stessa firma
 * `{ notificationId, kind, actionId }` verso `handlePushAction`.
 */
notifee.onBackgroundEvent(async ({ type, detail }) => {
  await handleBackgroundNotificationEvent(type, detail);
});

AppRegistry.registerComponent(appName, () => App);
