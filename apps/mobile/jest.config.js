// Task 21 (version-bump.test.mjs): il preset RN trasforma solo js/ts/tsx e
// il testMatch di default non include .mjs — senza questi due aggiustamenti
// Jest ignorerebbe il file di test (0 match) o fallirebbe su "Unexpected
// token 'export'". `transform` sostituisce l'intera mappa del preset se
// impostato qui, quindi la ricostruiamo a partire da quella (mantenendo
// l'asset transformer per bmp/gif/... ereditato) invece di riscriverla a
// mano con un percorso interno del preset.
const rnPreset = require("@react-native/jest-preset");
const transform = { ...rnPreset.transform };
delete transform["^.+\\.(js|ts|tsx)$"];
transform["^.+\\.(js|mjs|ts|tsx)$"] = "babel-jest";

module.exports = {
  preset: "@react-native/jest-preset",
  transform,
  testMatch: [
    "**/__tests__/**/*.[jt]s?(x)",
    "**/?(*.)+(spec|test).[tj]s?(x)",
    "**/?(*.)+(spec|test).mjs",
  ],
  // Il pattern del preset RN è scritto per un node_modules piatto: con pnpm i
  // package stanno in node_modules/.pnpm/<nome>@<ver>/node_modules/<nome>, e il
  // primo segmento (.pnpm) non è in allowlist, quindi anche i sorgenti ESM di
  // react-native finirebbero fuori dalla trasformazione Babel. Saltando il
  // segmento .pnpm il match torna a cadere sul node_modules interno.
  //
  // ⚠️ L'allowlist eredita il limite del preset: il nome deve essere seguito da
  // "/", quindi `react-native` copre `react-native/...` ma NON i package
  // `react-native-<qualcosa>`. Ogni libreria RN pubblicata in ESM che aggiungeremo
  // (react-native-svg, react-native-gesture-handler, …) va aggiunta qui a mano,
  // altrimenti Jest fallisce con "Cannot use import statement outside a module".
  //
  // Task 13: aggiunte @react-navigation (i sorgenti pubblicati sono SOLO
  // ESM, `exports.default` punta a `lib/module`, verificato sul package.json
  // installato), @notifee/react-native (il suo `jest-mock.js` è un file ESM
  // sciolto alla radice del package, non sotto `lib/`) e
  // @react-native-async-storage (idem per `jest/AsyncStorageMock.js`).
  // react-native-screens, react-native-safe-area-context, i18next,
  // react-i18next e @tanstack/* risolvono già a CJS via `main` — non serve
  // aggiungerli.
  //
  // Task 16: aggiunto `react-native-markdown-display` per "Leggi il piano"
  // (`main` punta a `src/index.js`, sorgente ESM — verificato). La sua dip
  // `react-native-fit-image` risolve a CJS via `dist/` (verificato) e NON va
  // aggiunta; `markdown-it`/`css-to-react-native`/`prop-types` sono CJS pure.
  //
  // App M1+M2, Task 6: aggiunto `react-native-bottom-tabs` (tab bar nativa)
  // — `main`/l'export di default risolvono a `./lib/module/index.js`, ESM
  // puro (verificato con `npm view ... main module exports`), niente
  // variante CJS. `@bottom-tabs/react-navigation` STESSO non serve
  // aggiungerlo: la sua `exports` map CJS/ESM è regolare e risolve a
  // `lib/commonjs/index.js` sotto Jest (verificato con `require.resolve` DENTRO
  // un test). Il problema vero è a un livello più giù: quel `lib/commonjs`
  // compilato fa `require("color")` (solo per sfumare `tabBarInactiveTintColor`
  // quando non lo passiamo — noi lo passiamo sempre, ma il `require` è
  // top-level, gira comunque al solo import) e `color@5.0.3` è ESM PURO
  // (`"type":"module"`, nessuna build CJS) — così come le sue dipendenze
  // `color-convert@3`, `color-string@2` e, sotto entrambe, `color-name@2`
  // (verificato leggendo ogni `package.json` nello store pnpm, non assunto
  // dal nome del pacchetto: esistono anche `color@4`/`color-convert@1`
  // CJS più vecchi altrove nell'albero, per un consumer diverso — la
  // versione che conta è quella che `@bottom-tabs/react-navigation`
  // dichiara, `^5.0.0`). Tutti e quattro vanno quindi nell'allowlist.
  transformIgnorePatterns: [
    "node_modules/(?!\\.pnpm/)(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|@notifee|@react-native-async-storage|react-native-markdown-display|react-native-bottom-tabs|color-convert|color-string|color-name|color)/)",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // Review fase 4, finding CI: il default di Jest (5000ms) basta in locale ma
  // NON sui runner CI condivisi — un test genuino (render reale di
  // `AppProviders`, più mock di Keychain/AsyncStorage/notifee/i18n, un
  // `waitFor` su un evento AppState) può superarlo lì senza che ci sia nulla
  // di rotto: era la prima volta che la CI girava su questo branch, e ha
  // esposto esattamente questo margine stretto. 15s dà respiro reale senza
  // mascherare un test che pende per sempre (un hang vero lo supera comunque).
  testTimeout: 15000,
};
