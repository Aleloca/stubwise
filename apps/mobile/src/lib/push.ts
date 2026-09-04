import type { StubwiseClient } from "@stubwise/api-client";
import { getMessaging, onTokenRefresh } from "@react-native-firebase/messaging";
import notifee, { EventType } from "@notifee/react-native";
import i18n from "../i18n";
import { ALL_PUSH_CATEGORIES, handlePushAction } from "./push-actions";
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
 *    ⚠️ **I bottoni d'azione Android NON viaggiano nel canale** (un canale è
 *    volume/importanza/suono, non azioni): FCM auto-mostra le notifiche coi
 *    soli titolo/corpo quando l'app è in background — è un limite noto e
 *    documentato di v1, non qualcosa che questo file può risolvere da solo.
 *    Le azioni Android arrivano SOLO quando l'app è in primo piano, tramite
 *    `onForegroundEvent` più sotto: `PUSH_CATEGORIES.actions` è comunque la
 *    fonte di verità che un domani (mostrando la notifica a mano da un
 *    `onMessage`) le userebbe anche in background.
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

/** I dati custom di una notifica notifee, nella forma che `Notification.data` dichiara. */
type NotificationData = { [key: string]: string | object | number } | undefined;

/** Estrae `{ notificationId, kind }` dai dati custom di una notifica, o `null` se mancano. */
function parseNotificationData(data: NotificationData): { notificationId: string; kind: string } | null {
  const notificationId = data?.["notificationId"];
  const kind = data?.["kind"];
  if (typeof notificationId !== "string" || typeof kind !== "string") return null;
  return { notificationId, kind };
}

/**
 * Avvia la metà PUSH dell'app: registra il token (ora e a ogni refresh),
 * registra le categorie/canali e ascolta le pressioni sui bottoni mentre
 * l'app è in PRIMO PIANO (`onForegroundEvent` — il gemello in background sta
 * in `index.js`, FUORI da qualunque componente React: notifee/RNFirebase lo
 * richiedono a livello di modulo).
 *
 * Chiamata da `AppProviders` a ogni transizione verso `"authenticated"` — non
 * ha senso registrare un device per un utente sloggato, e un logout deve
 * poter fermare gli ascoltatori (per questo si ritorna una funzione di
 * cleanup, chiamata dall'`useEffect` che invoca `setupPush`).
 */
export function setupPush(client: StubwiseClient): () => void {
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

  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
    const parsed = parseNotificationData(detail.notification?.data);
    if (!parsed) return;
    const actionId = type === EventType.ACTION_PRESS ? (detail.pressAction?.id ?? "open") : "open";
    void handlePushAction({ ...parsed, actionId }, client);
  });

  return () => {
    unsubscribeRefresh();
    unsubscribeForeground();
  };
}
