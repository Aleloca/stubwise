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
