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
  transformIgnorePatterns: [
    "node_modules/(?!\\.pnpm/)(?!((jest-)?react-native|@react-native(-community)?)/)",
  ],
};
