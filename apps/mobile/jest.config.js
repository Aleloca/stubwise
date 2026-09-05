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
  transformIgnorePatterns: [
    "node_modules/(?!\\.pnpm/)(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|@notifee|@react-native-async-storage|react-native-markdown-display)/)",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};
