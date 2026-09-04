module.exports = {
  preset: "@react-native/jest-preset",
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
