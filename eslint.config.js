import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // **/.astro/ contiene i tipi generati da Astro (docs Starlight); non è
    // codice nostro e non va lintato.
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/coverage/",
      "**/.astro/",
      // Progetti nativi generati dallo scaffold React Native: non è codice JS/TS
      // nostro (Xcode, Gradle, Ruby).
      "apps/mobile/ios/",
      "apps/mobile/android/",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // React Native: gira su Hermes, non su Node né sul DOM. `__DEV__` è il solo
    // global del bundler che serve al codice dell'app.
    files: ["apps/mobile/**/*.{ts,tsx,js}"],
    languageOptions: {
      globals: {
        __DEV__: "readonly",
      },
    },
  },
  {
    // I file di configurazione di Metro, Babel e Jest sono caricati da Node in
    // CommonJS: `require` lì non è una scelta di stile.
    files: ["apps/mobile/*.config.js"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        module: "writable",
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
