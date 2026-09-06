import type { StubwiseClient } from "@stubwise/api-client";
import { getMessaging, onMessage, onTokenRefresh } from "@react-native-firebase/messaging";
import type { RemoteMessage } from "@react-native-firebase/messaging";
import notifee, { EventType } from "@notifee/react-native";
import { Platform } from "react-native";
import i18n from "../i18n";
import { ALL_PUSH_CATEGORIES, categoryFor, handlePushAction, pushActionEventFromNotifeeData } from "./push-actions";
import { currentPlatform, getPushToken } from "./push-token";

// API MODULARE di `@react-native-firebase/messaging` (v26): `getMessaging()`
// prende l'app di default, e ogni funzione (`getToken`, `onTokenRefresh`, …)
// la vuole come primo argomento — NON il vecchio `messaging().metodo()`
// namespaced, che questa versione non espone più (vedi `lib/push-token.ts`
// per i dettagli verificati sui `.d.ts` pubblicati).

/**
 * Registra il token push CORRENTE presso Stubwise. Best-effort e silenzioso
 * sull'ESITO (non sull'errore: vedi sotto) — è un UPSERT idempotente
 * (`deviceRegistrationSchema`), quindi va bene chiamarlo a ogni avvio senza
 * tenere traccia di "l'ho già fatto".
 *
 * Fallimento (rete assente, server irraggiungibile): NON si ritenta da qui —
 * il prossimo avvio autenticato (questa stessa funzione, rimontata da
 * `AppProviders`) o il prossimo `onTokenRefresh` sono il ritentativo
 * naturale. Si logga (`console.warn`, mai silenzioso: un device che smette di
 * ricevere push senza che NESSUNO ne veda traccia è il guasto peggiore da
 * diagnosticare) e si continua: un `setupPush()` che lanciasse bloccherebbe
 * l'avvio dell'app per un problema che riguarda solo le notifiche.
 */
async function registerCurrentToken(client: StubwiseClient): Promise<void> {
  try {
    const token = await getPushToken();
    if (!token) return;
    await client.me.registerDevice(token);
  } catch (error) {
    console.warn("stubwise: registrazione device push fallita", error);
  }
}

/**
 * Le categorie statiche (design doc §4/§6), tradotte nella lingua corrente e
 * registrate presso il SO:
 *
 *  - iOS: `setNotificationCategories` — è la lookup che rende possibili i
 *    bottoni d'azione rapida su una notifica mostrata dal SO (`aps.category`
 *    nel payload, costruito da `packages/notifications/src/push/payload.ts`,
 *    combacia con l'`id` di una di queste categorie).
 *  - Android: `createChannel` per categoria — un canale per `kind` (il payload
 *    FCM lo referenzia come `channel_id`, vedi `apps/push-relay/src/fcm.ts`),
 *    così un canale sconosciuto non fa sparire la notifica in silenzio.
 *    ⚠️ **Il canale NON porta le azioni** (è volume/importanza/suono, non
 *    bottoni — verificato: `AndroidChannel` non ha un campo `actions` nei
 *    `.d.ts` di notifee). Le azioni Android vivono SOLO sulla singola
 *    notifica *mostrata*: in background FCM la mostra da SOLO, coi soli
 *    titolo/corpo (limite noto di v1, vedi `index.js`); in PRIMO PIANO FCM
 *    su Android NON mostra nulla da sé (verificato sui sorgenti nativi:
 *    `ReactNativeFirebaseMessagingReceiver.onReceive`, ramo foreground, emette
 *    solo l'evento JS) — è `displayForegroundAndroidNotification` più sotto,
 *    agganciata a `onMessage`, a ridisegnarla con le azioni di
 *    `categoryFor(kind)`. `onForegroundEvent` gestisce poi le PRESSIONI su
 *    quella notifica, non la sua comparsa.
 */
async function registerCategories(): Promise<void> {
  const categories = ALL_PUSH_CATEGORIES.map((category) => ({
    id: category.id,
    actions: category.actions.map((action) => ({ id: action.id, title: i18n.t(action.titleKey) })),
  }));
  // `setNotificationCategories` è `@platform ios` ma sicura da chiamare
  // ovunque: notifee documenta che le API iOS-only sono no-op (mai un
  // rifiuto) sulle altre piattaforme — vedi `getNotificationCategories`
  // ("Returns an empty array on Android") nello stesso modulo.
  await notifee.setNotificationCategories(categories);
  for (const category of ALL_PUSH_CATEGORIES) {
    await notifee.createChannel({ id: category.id, name: category.id });
  }
}

/** I dati custom di un `RemoteMessage`, nella forma che `RemoteMessage.data` dichiara. */
type NotificationData = { [key: string]: string | object | number } | undefined;

/**
 * Estrae `{ notificationId, kind }` da `RemoteMessage.data`, o `null` se
 * mancano — usata SOLO da `displayForegroundAndroidNotification` qui sotto,
 * che non ha un `actionId` da derivare (non è un'interazione, è l'arrivo del
 * messaggio). Per l'ALTRO caso — un'interazione notifee (press/action-press,
 * che porta anche l'azione scelta) — vedi
 * `pushActionEventFromNotifeeData` in `push-actions.ts`, condivisa con
 * `index.js`.
 */
function parseNotificationData(data: NotificationData): { notificationId: string; kind: string } | null {
  const notificationId = data?.["notificationId"];
  const kind = data?.["kind"];
  if (typeof notificationId !== "string" || typeof kind !== "string") return null;
  return { notificationId, kind };
}

/**
 * Ridisegna a mano, SOLO su Android, la notifica di un messaggio FCM
 * ricevuto in PRIMO PIANO — con le azioni rapide di `categoryFor(kind)`.
 *
 * ⚠️ **Perché serve, verificato sui sorgenti nativi installati** (non
 * assunto): `ReactNativeFirebaseMessagingReceiver.onReceive`
 * (`@react-native-firebase/messaging/android/.../ReactNativeFirebaseMessagingReceiver.java`),
 * ramo `App in Foreground`, si limita a `emitter.sendEvent(...)` (l'evento
 * che alimenta `onMessage`) e fa `return` — NESSUNA chiamata a un'API di
 * sistema che mostri qualcosa. A differenza del background (dove FCM la
 * mostra DA SOLO, senza azioni: vedi il docblock di `registerCategories`),
 * su Android in primo piano un push senza questa funzione non produce
 * NESSUNA notifica — non "senza bottoni", proprio nessuna.
 *
 * **Perché SOLO Android, e non anche iOS** (stesso motivo, verificato):
 * `RNFBMessaging+UNUserNotificationCenter.m`, `willPresentNotification`,
 * emette SEMPRE lo stesso evento `messaging_message_received` (quindi
 * `onMessage` scatta anche lì) — ma la notifica la mostra già il SO via
 * APNs, in ogni stato dell'app (`AppDelegate.willPresent`, vedi il commento
 * lì sull'ordine dei delegate). Chiamare `displayNotification` anche su iOS
 * duplicherebbe la notifica: una dal SO, una nostra.
 *
 * `id: notificationId` (non generato): riusa la stessa notifica locale se
 * `onMessage` scattasse due volte per lo stesso push, invece di impilarne
 * una seconda — lo stesso principio del `collapseId` lato server.
 */
function displayForegroundAndroidNotification(remoteMessage: RemoteMessage): void {
  if (Platform.OS !== "android") return;
  const parsed = parseNotificationData(remoteMessage.data);
  if (!parsed) return;
  const category = categoryFor(parsed.kind);
  void notifee.displayNotification({
    id: parsed.notificationId,
    title: remoteMessage.notification?.title,
    body: remoteMessage.notification?.body,
    data: remoteMessage.data,
    android: {
      channelId: category.id,
      pressAction: { id: "default" },
      actions: category.actions.map((action) => ({
        title: i18n.t(action.titleKey),
        pressAction: { id: action.id },
      })),
    },
  });
}

/**
 * Avvia la metà PUSH dell'app: registra il token (ora e a ogni refresh),
 * registra le categorie/canali, ridisegna (Android, primo piano — vedi
 * `displayForegroundAndroidNotification`) e ascolta le pressioni sui
 * bottoni mentre l'app è in PRIMO PIANO (`onForegroundEvent` — il gemello in
 * background sta in `index.js`, FUORI da qualunque componente React:
 * notifee/RNFirebase lo richiedono a livello di modulo).
 *
 * `onPushReceived` (review fase 4, finding #2): chiamata a OGNI `onMessage`,
 * su ENTRAMBE le piattaforme — un push arrivato in primo piano può aver
 * cambiato l'inbox (una risposta, un job finito), quindi la lista e il
 * badge non devono restare stantii fino al prossimo foreground o al
 * prossimo giro dei 60s. `AppProviders` ci passa la STESSA funzione che usa
 * per il refresh al foreground: un solo punto che decide "cosa si
 * aggiorna", non due implementazioni indipendenti che potrebbero divergere.
 * Parametro opzionale (non tutti i chiamanti/test hanno bisogno del
 * refresh) e chiamata anche quando `remoteMessage.data` non parsa (una
 * notifica non nostra non deve per questo saltare il refresh: il refresh
 * non dipende dal contenuto del singolo messaggio, solo dal fatto che UNA
 * push sia arrivata).
 *
 * Chiamata da `AppProviders` a ogni transizione verso `"authenticated"` — non
 * ha senso registrare un device per un utente sloggato, e un logout deve
 * poter fermare gli ascoltatori (per questo si ritorna una funzione di
 * cleanup, chiamata dall'`useEffect` che invoca `setupPush`).
 */
export function setupPush(client: StubwiseClient, onPushReceived?: () => void): () => void {
  // Le categorie/canali PRIMA del token, non in parallelo: su Android una
  // notifica il cui `channel_id` non esiste ancora sul device viene SCARTATA
  // dal SO in silenzio (comportamento documentato di FCM/Android, non un
  // bug nostro). Registrare il token rende il device raggiungibile da una
  // push — chiudere questa finestra (stretta ma reale al primo login, prima
  // che `registerCategories` abbia mai girato) costa un `await` in più, non
  // un giro di rete aggiuntivo: `createChannel` è locale.
  void (async () => {
    await registerCategories();
    await registerCurrentToken(client);
  })();

  const unsubscribeRefresh = onTokenRefresh(getMessaging(), (token: string) => {
    void client.me.registerDevice({ platform: currentPlatform(), token }).catch((error: unknown) => {
      console.warn("stubwise: registrazione device push fallita (refresh token)", error);
    });
  });

  // Android, primo piano: FCM non mostra nulla da sé (vedi il docblock di
  // `displayForegroundAndroidNotification`) — la ridisegniamo qui. Su iOS la
  // funzione è un no-op (guardia `Platform.OS`): la notifica la mostra già
  // il SO via APNs, vedi `AppDelegate.swift`.
  const unsubscribeMessage = onMessage(getMessaging(), (remoteMessage: RemoteMessage) => {
    displayForegroundAndroidNotification(remoteMessage);
    onPushReceived?.();
  });

  // `pushActionEventFromNotifeeData` (in `push-actions.ts`) è la STESSA
  // funzione che usa `index.js` per il gemello in background — un cambio di
  // forma del payload aggiornato solo lì lascerebbe l'altro disallineato in
  // silenzio, vedi il docblock lì.
  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
    const event = pushActionEventFromNotifeeData(
      detail.notification?.data,
      type === EventType.ACTION_PRESS ? detail.pressAction?.id : undefined,
    );
    if (!event) return;
    void handlePushAction(event, client);
  });

  return () => {
    unsubscribeRefresh();
    unsubscribeMessage();
    unsubscribeForeground();
  };
}
