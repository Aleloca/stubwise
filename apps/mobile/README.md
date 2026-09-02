# @stubwise/mobile

App React Native **bare** (niente Expo) di Stubwise, per iOS e Android.
Bundle id iOS e `applicationId` Android: `com.app.aleloca.stubwise`; nome
visualizzato: **Stubwise**.

Al momento è solo lo scheletro della Fase 4: `App.tsx` importa
`ticketStatusSchema` da `@stubwise/shared` e ne mostra il numero di stati. Serve
a dimostrare che Metro risolve i package del workspace pnpm. Le schermate vere
arrivano nei task successivi.

## Prerequisiti

- Node >= 22 e pnpm 10.9 (come il resto del monorepo).
- **iOS**: Xcode con i Command Line Tools, un simulatore installato e
  CocoaPods (`sudo gem install cocoapods`, oppure `bundle install` dalla dir
  `apps/mobile` per usare le versioni pinnate nel `Gemfile`).
- **Android**: JDK 17 e Android Studio con un SDK e un emulatore configurati
  (`ANDROID_HOME` che punta all'SDK).

## Comandi

Dalla radice del monorepo:

```bash
pnpm --filter @stubwise/mobile ios        # build + avvio sul simulatore iOS
pnpm --filter @stubwise/mobile android    # build + avvio sull'emulatore Android
pnpm --filter @stubwise/mobile start      # solo il dev server Metro
pnpm --filter @stubwise/mobile typecheck  # tsc --noEmit
pnpm --filter @stubwise/mobile test       # Jest
```

La prima esecuzione su iOS richiede i pod:

```bash
cd apps/mobile/ios && pod install
```

### Scegliere il simulatore iOS

**Scegli il simulatore per UDID.** Due trappole, entrambe già incontrate:

1. senza `--simulator`/`--udid` il CLI riusa il simulatore **già avviato**, che
   può essere un runtime vecchio;
2. `--simulator "<nome>"` è **ambiguo**: lo stesso nome di device esiste su ogni
   runtime installato (p.es. tre "iPhone 17 Pro", su iOS 26.1, 26.2 e 26.5) e il
   CLI può atterrare su quello sbagliato.

```bash
xcrun simctl list devices available   # UDID raggruppati per runtime
pnpm --filter @stubwise/mobile ios --udid <UDID>
xcrun simctl list devices booted      # su cosa è partita davvero
```

Lo script `ios` in `package.json` resta volutamente generico: ogni sviluppatore
ha runtime e device diversi.

Runtime su cui l'app è stata verificata: **iOS 26.5** (iPhone 17 Pro), con
Xcode 26.6 — il cui SDK simulatore più recente è appunto `iphonesimulator26.5`.

### Porta di Metro

Metro usa la 8081. Se è già occupata da un altro progetto, il bundle che l'app
scarica è quello dell'ALTRO progetto (si manifesta come un red screen con errori
su moduli nativi che qui non esistono). Usa una porta libera e dì all'app di
usarla:

```bash
pnpm --filter @stubwise/mobile start --port 8082
xcrun simctl spawn <UDID> defaults write com.app.aleloca.stubwise RCT_jsLocation "localhost:8082"
pnpm --filter @stubwise/mobile ios --udid <UDID> --port 8082
```

(`RCT_jsLocation` è la stessa impostazione del Dev Menu → "Configure Bundler".)

## Metro e pnpm

Il monorepo usa il layout pnpm di default (`node_modules` isolato, package del
workspace come symlink): **non** è stato necessario il fallback
`node-linker=hoisted`. Bastano due impostazioni in `metro.config.js`:

- `watchFolders: [<radice del monorepo>]`, perché i sorgenti di
  `packages/shared` stanno fuori da `apps/mobile`;
- `resolver.unstable_enableSymlinks` + `resolver.nodeModulesPaths` con il
  `node_modules` locale e quello di radice.

Stesso motivo per l'override di `transformIgnorePatterns` in `jest.config.js`:
il pattern del preset React Native è scritto per un `node_modules` piatto e
sotto pnpm escluderebbe dalla trasformazione Babel anche i sorgenti ESM di
`react-native` (che stanno in `node_modules/.pnpm/<pkg>/node_modules/<pkg>`).

In `babel.config.js` è aggiunto `@babel/plugin-transform-export-namespace-from`:
il preset React Native non trasforma `export * as ns from "..."`, sintassi che
zod (dipendenza di `@stubwise/shared`) usa nei suoi sorgenti ESM.

Il lint è centralizzato nella `eslint.config.js` di radice, che ignora
`apps/mobile/ios` e `apps/mobile/android` (progetti nativi generati).
