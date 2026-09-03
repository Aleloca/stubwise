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
  },
  {
    // jest.setup.ts usa `jest.mock(nome, () => require(...))`: è il pattern
    // documentato dai package stessi (async-storage, notifee, device-info,
    // netinfo, safe-area-context) per caricare il proprio mock ufficiale —
    // `import` in cima al file non funzionerebbe per lo stesso motivo per
    // cui jest.mock() richiede una factory: deve restare `require()`
    // dentro la callback, valutato quando il modulo viene richiesto DAVVERO.
    files: ["apps/mobile/jest.setup.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // CONFINE CLIENT/SERVER sui package del workspace.
    //
    // `@stubwise/notifications` espone due entry: `.` (pubblicazione, routing,
    // dispatch — parla con Postgres) e `./pure` (testo e catalogo delle azioni,
    // senza DB). Un client deve importare la seconda, e qui lo si RENDE
    // IMPOSSIBILE invece di sperarlo.
    //
    // Perché è una regola di lint e non "ci si sta attenti": i due bundler si
    // comportano in modo opposto davanti allo stesso errore. Metro fallisce il
    // bundle, rumorosamente, e l'errore non arriva mai in produzione. Vite
    // INVECE esternalizza `net`/`tls`/`postgres` con un warning e produce un
    // bundle che sembra a posto e poi esplode a runtime, in una pagina, davanti
    // a un utente. Il caso pericoloso è quindi proprio quello web, dove nessun
    // build lo intercetta — mentre la CI fallisce sul lint.
    // `packages/api-client` è nell'elenco perché finisce in ENTRAMBI i bundle
    // client (Vite per la SPA, Metro per la mobile): un import del DB qui
    // produrrebbe lo stesso bundle rotto, un livello più in basso.
    files: ["apps/web/src/**", "apps/mobile/**/*.{ts,tsx}", "packages/api-client/src/**"],
    rules: {
      // `patterns` con `regex`, non `paths`: `paths` confronta il nome ESATTO,
      // quindi lascerebbe passare i sottopercorsi — e `@stubwise/db/testing` è
      // un sottopercorso davvero esportato, cioè un aggiramento raggiungibile
      // per distrazione. La forma `patterns` con negazione gitignore
      // ("!@stubwise/notifications/pure") NON funziona su ESLint 9: segnala
      // anche ./pure. Verificato, non riprovarla.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@stubwise/notifications(?!/pure$)(/|$)",
              message:
                "Lato client si importa da @stubwise/notifications/pure (entry senza DB). L'entry `.` trascina @stubwise/db e il driver postgres: Metro non la bundla e Vite produce un bundle che esplode a runtime.",
            },
            {
              regex: "^@stubwise/db(/|$)",
              message: "Il DB non entra nei bundle client: passa dall'API del server.",
            },
          ],
        },
      ],
    },
  },
);
