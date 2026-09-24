/**
 * Necessario perché `@testing-library/react-native` sappia che è lecito
 * fare `setState` fuori da un giro sincrono di `act()` — succede in OGNI
 * screen che carica dati all'avvio (`AppProviders`, `OnboardingScreen`): la
 * `Promise` si risolve su un microtask che il singolo `act()` sincrono di
 * `render()` non copre. Senza questa riga React stampa "The current testing
 * environment is not configured to support act(...)" e — verificato — gli
 * aggiornamenti di stato che ne conseguono arrivano in modo incoerente da
 * un test all'altro nello stesso file (`getByTestId` che trova l'elemento
 * in un test e non nel successivo, a parità di codice).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mock dei moduli nativi per Jest. Dove il package spedisce un mock
 * ufficiale lo si usa (async-storage, notifee, device-info, netinfo);
 * `react-native-keychain` (10.0.0, verificato) NON ne spedisce uno — mockato
 * a mano con `jest.fn()` sulle sole funzioni che l'app usa
 * (`{set,get,reset}GenericPassword`).
 */

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest"),
);

jest.mock("react-native-keychain", () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

jest.mock("@notifee/react-native", () => require("@notifee/react-native/jest-mock"));

jest.mock("react-native-device-info", () =>
  require("react-native-device-info/jest/react-native-device-info-mock"),
);

jest.mock("@react-native-community/netinfo", () => require("@react-native-community/netinfo/jest/netinfo-mock"));

/**
 * `@react-native-firebase/messaging` (Task 19) NON spedisce un mock ufficiale
 * per Jest — mock a mano, con le sole funzioni che questo repo usa
 * (`getToken`/`onTokenRefresh`/`onMessage`, lette da `lib/push-token.ts` e
 * `lib/push.ts`).
 *
 * API MODULARE (v26, verificata sui `.d.ts` pubblicati: il pacchetto non
 * esporta più un `default` namespaced `messaging()`): `getMessaging()` prende
 * l'app di default, e ogni funzione la vuole come primo argomento — il mock
 * qui sotto ignora quell'argomento (nessun test ha bisogno di distinguere fra
 * app diverse) e si comporta come un singolo store globale di `jest.fn()`.
 *
 * `getToken` risolve `null` di DEFAULT (nessun token): un token presente è il
 * caso ECCEZIONALE che ogni test interessato attiva da sé con
 * `mockResolvedValueOnce`/`mockResolvedValue` — stesso principio di
 * `mockLoadSession.mockResolvedValue(null)` in `client.test.ts`, e per la
 * stessa ragione: un default "c'è un token" farebbe scattare
 * `registerDevice` in OGNI test che monta `AppProviders` o `OnboardingScreen`,
 * anche quelli che non stanno testando la push.
 */
jest.mock("@react-native-firebase/messaging", () => ({
  __esModule: true,
  getMessaging: jest.fn(() => ({})),
  getToken: jest.fn(async () => null),
  // Task 20 (logout): invalida il token FCM del device — vedi
  // `screens/settings/SettingsSheet.tsx`. Risolve `undefined` di default
  // (`Promise<void>` reale): il test che vuole verificarne la CHIAMATA lo fa
  // sul mock stesso (`deleteToken as jest.Mock`), non sul suo valore di
  // ritorno.
  deleteToken: jest.fn(async () => undefined),
  onTokenRefresh: jest.fn(() => jest.fn()),
  onMessage: jest.fn(() => jest.fn()),
  setBackgroundMessageHandler: jest.fn(),
}));

/**
 * Senza questo mock `SafeAreaProvider` non renderizza i figli in Jest: sotto
 * test non arriva mai l'evento nativo `onInsetsChange` che gli dice quali
 * insets usare, quindi resta in attesa per sempre (`<RNCSafeAreaProvider />`
 * vuoto — verificato: era la causa di OGNI `getByTestId` fallito prima di
 * questa riga).
 */
// Il mock ufficiale esporta tutto sotto `.default` (è un modulo ESM
// compilato con `__esModule: true`): senza `.default` qui, un `import {
// SafeAreaProvider }` a named import prenderebbe `undefined` — verificato,
// era il primo errore ("Element type is invalid") prima di questa riga.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);

/**
 * `useBottomTabBarHeight()` (Task 7, App M1+M2, 11 set 2026 — la barra
 * nativa) LANCIA se chiamato fuori da un discendente montato dentro il
 * `TabView` reale (`BottomTabBarHeightContext` nasce `undefined` — verificato
 * leggendo il sorgente del hook, non assunto): ogni test che monta una
 * schermata DIRETTAMENTE (senza l'albero completo di `RootNavigator`, il caso
 * comune di questo repo — vedi `InboxScreen.test.tsx` e affini) altrimenti
 * fallirebbe con "Couldn't find the bottom tab bar height" appena la
 * schermata chiamasse quel hook per il margine di scorrimento in fondo (Task
 * 6). Mock PARZIALE (`requireActual` + override del solo hook): il resto del
 * pacchetto (`TabView`, `SceneMap`, il default export) resta vero, perché
 * `navigation.test.tsx` monta l'albero reale e ne ha bisogno. Il valore fisso
 * (0) non pretende di somigliare a un'altezza vera — nessuna build nativa
 * gira sotto Jest, quindi nessun numero qui sarebbe più "vero" di un altro
 * (vedi il Task 8, verifica manuale sul telefono).
 *
 * ⚠️ `__esModule: true` è OBBLIGATORIO qui (stesso motivo del mock di
 * `react-native-safe-area-context` sopra): il pacchetto è compilato ESM, il
 * suo `export default TabView` vive sotto `.default`. Senza questo flag
 * l'oggetto ritornato dalla factory diventerebbe esso stesso il default
 * export per l'interop di Babel — `NativeBottomTabView` proverebbe a
 * renderizzare l'INTERO oggetto del mock come componente ("Element type is
 * invalid... expected a string or class/function but got: object"),
 * verificato di persona rompendo `navigation.test.tsx` prima di aggiungerlo.
 */
jest.mock("react-native-bottom-tabs", () => ({
  __esModule: true,
  ...jest.requireActual("react-native-bottom-tabs"),
  useBottomTabBarHeight: jest.fn(() => 0),
}));

/**
 * IL FOGLIO NATIVO (`@lodev09/react-native-true-sheet`, 24 set 2026): in Jest
 * non esiste — è `UISheetPresentationController`, niente JavaScript da
 * eseguire. Qui lo sostituisce un contenitore che rende i figli finché è
 * PRESENTATO, e li toglie quando non lo è: la stessa forma di prima dei
 * `Modal`, così i test dei dieci pannelli — che asseriscono il CONTENUTO, non
 * il contenitore — restano validi senza toccarli uno per uno.
 *
 * Globale e non per file (come in Half Story, dove si mocka `SheetModal`
 * file per file): mockando la LIBRERIA, `SheetModal` gira davvero nei test,
 * con le sue regole — aperto/chiuso dalla prop, `dismissible`.
 *
 * Due cose del foglio vero che questo riproduce, perché i test ci si
 * appoggiano:
 *
 * - il TRASCINAMENTO per chiudere: un bottone nascosto `true-sheet-dismiss`
 *   fa quello che farebbe il dito — chiude e chiama `onDidDismiss` — ma SOLO
 *   se `dismissible` non è `false`, esattamente come il sistema;
 * - la chiusura DA CODICE (`dismiss()`, quando `open` torna falso) chiama
 *   anch'essa `onDidDismiss`, come fa la libreria vera: un pannello che
 *   reagisce a `onClose` deve reggere quel secondo avviso.
 */
jest.mock("@lodev09/react-native-true-sheet", () => {
  const React = require("react");
  const { Pressable, View } = require("react-native");
  type MockSheetProps = {
    children?: unknown;
    dismissible?: boolean;
    onDidDismiss?: () => void;
  };
  const TrueSheet = React.forwardRef((props: MockSheetProps, ref: unknown) => {
    const [presented, setPresented] = React.useState(false);
    const presentedRef = React.useRef(false);
    const propsRef = React.useRef(props);
    propsRef.current = props;
    React.useImperativeHandle(ref, () => ({
      present: async () => {
        presentedRef.current = true;
        setPresented(true);
      },
      dismiss: async () => {
        if (!presentedRef.current) return;
        presentedRef.current = false;
        setPresented(false);
        propsRef.current.onDidDismiss?.();
      },
    }));
    if (!presented) return null;
    return React.createElement(
      View,
      { testID: "true-sheet" },
      props.children,
      React.createElement(Pressable, {
        testID: "true-sheet-dismiss",
        onPress: () => {
          if (propsRef.current.dismissible === false) return;
          presentedRef.current = false;
          setPresented(false);
          propsRef.current.onDidDismiss?.();
        },
      }),
    );
  });
  return { TrueSheet };
});
