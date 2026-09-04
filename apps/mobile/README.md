# @stubwise/mobile

App React Native **bare** (niente Expo) di Stubwise, per iOS e Android.
Bundle id iOS e `applicationId` Android: `com.app.aleloca.stubwise`; nome
visualizzato: **Stubwise**.

Dal Task 13 (fondamenta): tema, i18n, sessione (Keychain), client HTTP verso
`@stubwise/api-client`, navigazione (`@react-navigation`, deep link
`stubwise://…`), login e onboarding. `src/app/App.tsx` è la radice; i tab di
`Main` (Inbox/Progetti/Backlog/Docs) sono ancora placeholder — il contenuto
vero arriva nei task 14–18.

## Prerequisiti

- Node >= 22 e pnpm 10.9 (come il resto del monorepo).
- **`pnpm install && pnpm -r build` dalla radice, almeno una volta.** Non è
  facoltativo: vedi "Il build di `packages/*` non è opzionale" più sotto.
- **iOS**: Xcode con i Command Line Tools, un simulatore installato e i pod.
  Per i pod usa il `Gemfile` già presente nello scaffold, che pinna le versioni
  note-buone di CocoaPods:

  ```bash
  cd apps/mobile && bundle install   # una volta sola
  cd ios && bundle exec pod install
  ```

  (`sudo gem install cocoapods` sul Ruby di sistema funziona ma è la strada che
  la documentazione React Native sconsiglia: niente pin, e tocca il Ruby di
  sistema.)
- **Android**: JDK 17 e Android Studio con un SDK e un emulatore configurati
  (`ANDROID_HOME` che punta all'SDK).

## Il build di `packages/*` non è opzionale

`@stubwise/shared` espone `exports["."] → ./dist/index.js`, e `dist/` è
gitignorato: Metro e Jest risolvono la **dist**, non `src`. Su un clone fresco,
senza `pnpm -r build`, sia `pnpm --filter @stubwise/mobile test` sia
`… ios` falliscono con «Cannot find module `@stubwise/shared`». In CI non si
vede perché `pnpm -r build` precede sempre i test.

Stessa cosa quando **modifichi** `packages/shared/src`: finché non rifai
`pnpm --filter @stubwise/shared build` l'app continua a vedere la dist vecchia
(la trappola "dist stale" già nota nel repo), e qui va anche svuotata la cache
di Metro:

```bash
pnpm --filter @stubwise/shared build
pnpm --filter @stubwise/mobile start --reset-cache
```

## Comandi

Dalla radice del monorepo:

```bash
pnpm --filter @stubwise/mobile ios        # build + avvio su simulatore o device
pnpm --filter @stubwise/mobile android    # build + avvio sull'emulatore Android
pnpm --filter @stubwise/mobile start      # solo il dev server Metro
pnpm --filter @stubwise/mobile typecheck  # tsc --noEmit
pnpm --filter @stubwise/mobile test       # Jest
```

### Scegliere il device o il simulatore

**Scegli sempre per UDID.** Due trappole, entrambe già incontrate:

1. senza `--udid` il CLI riusa il simulatore **già avviato**, che può essere un
   runtime vecchio;
2. `--simulator "<nome>"` è **ambiguo**: lo stesso nome di device esiste su ogni
   runtime installato (p.es. tre "iPhone 17 Pro", su iOS 26.1, 26.2 e 26.5) e il
   CLI può atterrare su quello sbagliato.

```bash
xcrun simctl list devices available   # simulatori, UDID raggruppati per runtime
xcrun devicectl list devices          # iPhone/iPad fisici collegati
pnpm --filter @stubwise/mobile ios --udid <UDID>
xcrun simctl list devices booted      # su quale simulatore è partita davvero
```

⚠️ **Dal Task 19 in poi il device fisico è obbligatorio, non una preferenza:**
le push APNs non arrivano sul simulatore.

Lo script `ios` in `package.json` resta volutamente generico: ogni sviluppatore
ha runtime e device diversi.

### Firma (iOS)

`project.pbxproj` contiene `DEVELOPMENT_TEAM = 6ZQUNJK5N4` (Alessandro
Locatelli) e `CODE_SIGN_STYLE = Automatic` su Debug e Release. Senza, un build
su device fisico fallisce con «Signing for "StubwiseMobile" requires a
development team».

**Committare il team ID è deliberato, non una svista.** Il modello a relay del
piano di fase 4 prevede una sola app sugli store — la nostra — quindi esiste un
solo team di firma legittimo, e un team ID non è un segreto (compare in ogni
app distribuita). Il bundle id `com.app.aleloca.stubwise` segue la convenzione
`com.app.aleloca.*` già usata da quel team ed è coperto dal profilo wildcard.

Chi **forka** il repo deve cambiare due cose: il proprio `DEVELOPMENT_TEAM` e un
bundle id sotto un prefisso che gli appartiene (`PRODUCT_BUNDLE_IDENTIFIER` in
`project.pbxproj`, più `applicationId`/`namespace` in
`android/app/build.gradle`).

### Porta di Metro

Metro usa la 8081. Se è già occupata da un altro progetto (in pratica: da
`half-story-app` su questa macchina — verificato più volte, `lsof -i :8081`
lo conferma), il bundle che l'app scarica è quello dell'ALTRO progetto (si
manifesta come un red screen con errori su moduli nativi che qui non
esistono). Usa una porta libera e dì all'app di usarla — **il modo cambia fra
simulatore e device fisico, verificato in entrambi i casi**:

```bash
pnpm --filter @stubwise/mobile start --port 8082
```

**Simulatore**: `xcrun simctl spawn` gira PROCESSI dentro il simulatore, che
condivide il meccanismo `defaults` dell'host — quindi puoi scrivere
`RCT_jsLocation` da fuori:

```bash
xcrun simctl spawn <UDID> defaults write com.app.aleloca.stubwise RCT_jsLocation "localhost:8082"
pnpm --filter @stubwise/mobile ios --udid <UDID> --port 8082
```

**Device fisico**: `RCT_jsLocation` vive negli `NSUserDefaults` DENTRO la
sandbox dell'app sul telefono — non c'è un equivalente di `simctl spawn` per
scriverli da riga di comando (verificato: `xcrun devicectl device process
launch --environment-variables '{"RCT_METRO_PORT":"8082"}'` non ha effetto,
l'app continua a chiedere la 8081; `devicectl device copy` scrive solo nella
cartella Documents condivisa dell'app, non in Library/Preferences). L'unico
modo pulito è dal **Dev Menu sul telefono** (scuoti il device, o tocca tre
volte con tre dita → "Configure Bundler" → host e porta) DOPO il primo avvio
dell'app — l'app parte comunque (prova a chiamare la 8081, fallisce, mostra
il red screen di "no bundler"), poi da lì cambi la porta e l'app si
riconnette da sola, senza reinstallare nulla:

```bash
pnpm --filter @stubwise/mobile ios --udid <UDID> --port 8082
# poi sul telefono: scuoti il device → Configure Bundler → 8082
```

(`RCT_jsLocation` è la stessa impostazione del Dev Menu → "Configure Bundler".)

## Metro e pnpm

Il monorepo usa il layout pnpm di default (`node_modules` isolato, package del
workspace come symlink): **non** è stato necessario il fallback
`node-linker=hoisted`. In `metro.config.js` basta **una** impostazione,
`watchFolders: [<radice del monorepo>]`: Metro indicizza solo la project root e
le watchFolders, e i file che l'app importa stanno fuori da `apps/mobile` — sia
i realpath dei package del workspace (`packages/shared`) sia lo store
`node_modules/.pnpm` da cui arrivano `react-native` e `@babel/runtime`. I
symlink li segue da sé.

C'è poi una `resolver.blockList` per escludere i git worktree in
`<radice>/.worktrees/`, che hanno ognuno il proprio `node_modules/.pnpm`: è
ancorata al percorso della radice, perché un pattern generico su `.worktrees`
bloccherebbe i sorgenti dell'app quando si lavora *dentro* un worktree.

Anche `jest.config.js` paga il layout di pnpm, e sovrascrive
`transformIgnorePatterns`: il
pattern del preset React Native è scritto per un `node_modules` piatto e sotto
pnpm escluderebbe dalla trasformazione Babel anche i sorgenti ESM di
`react-native` (che stanno in `node_modules/.pnpm/<pkg>/node_modules/<pkg>`).

In `babel.config.js` è aggiunto `@babel/plugin-transform-export-namespace-from`:
il preset React Native non trasforma `export * as ns from "..."`, sintassi che
zod (dipendenza di `@stubwise/shared`) usa nei suoi sorgenti ESM.

Il lint è centralizzato nella `eslint.config.js` di radice, che ignora
`apps/mobile/ios` e `apps/mobile/android` (progetti nativi generati).

`@babel/runtime` è una dependency DIRETTA di `packages/api-client` (Task 13)
anche se nessun sorgente TS del package lo importa: Metro trasforma con Babel
anche il `dist/index.js` già compilato di `api-client` quando lo bundla per
questa app, e quella trasformazione inietta `require("@babel/runtime/helpers/...")`.
Sotto pnpm — niente hoisting dei transitive — quell'helper deve essere una
dependency dichiarata del package che lo importa, altrimenti Metro non lo
risolve. Un depcheck/knip (o un umano che cerca `@babel/runtime` nei sorgenti
TS e non lo trova) lo scambierebbe per morto: la rottura si vedrebbe solo al
bundle Metro dell'app mobile, mai nei test Vitest di `api-client` (che non
passano da Metro).

## Push (Task 19)

Registrazione del device, categorie/azioni rapide sulle notifiche e badge —
`src/lib/push.ts` (`setupPush`, montato da `AppProviders` a ogni avvio
autenticato), `src/lib/push-actions.ts` (`categoryFor`, `handlePushAction` —
puri, testati senza device), `src/lib/push-token.ts`. Il routing è FCM-first
**anche su iOS** (`@react-native-firebase/messaging`, API MODULARE
`getMessaging()`/`getToken()`/`onTokenRefresh()` — la v26 installata qui non
espone più il vecchio `messaging()` namespaced, verificato sui `.d.ts`
pubblicati): l'app sugli store è una sola, quindi un solo progetto Firebase.
Il modello è **relay-only** (design doc §5): le chiavi APNs/FCM vivono SOLO
nel `.env` di `apps/push-relay` sul nostro VPS — quest'app non le vede mai.

⚠️ **Le push APNs non arrivano sul simulatore: dal Task 19 in poi il device
fisico è obbligatorio** (vedi "Scegliere il device o il simulatore" sopra). La
prova reale è rimandata al Task 23 (istanza prod configurata) — quanto segue
porta la configurazione a uno stato pronto per quella prova, non la sostituisce.

### File di chiavi (NON nel repo)

`GoogleService-Info.plist` (iOS) e `google-services.json` (Android) — scaricati
dalla console Firebase del progetto (bundle id / `applicationId`
`com.app.aleloca.stubwise`) — sono in `.gitignore` per lo stesso motivo delle
chiavi del relay: nessun'istanza self-hosted deve poterle vedere. Vanno
piazzati a mano:

- **iOS**: `apps/mobile/ios/StubwiseMobile/GoogleService-Info.plist`, POI
  trascinato dentro Xcode nel target `StubwiseMobile` ("Copy items if needed",
  membership sul target app) — piazzarlo solo nella cartella NON basta, Xcode
  deve avere un riferimento al file per includerlo nel bundle.
- **Android**: `apps/mobile/android/app/google-services.json` — nessun passo
  Xcode-equivalente, il plugin Gradle (sotto) lo trova da solo per posizione.

Senza questi file l'app COMPILA (il plugin Gradle fallisce solo se manca
`google-services.json`; su iOS `FirebaseApp.configure()` — vedi `AppDelegate.swift`
— solleva un'eccezione runtime alla prima chiamata, non un errore di build) ma
non registra mai un token vero.

### Cosa fa già il codice committato

- **iOS**: `Podfile` ha `$RNFirebaseDisableSPM = true` (RN >= 0.75 userebbe
  Swift Package Manager per Firebase di default, che richiede linking dinamico
  per TUTTI i pod — questo flag tiene Firebase sulla stessa strada CocoaPods
  statica del resto del progetto). `AppDelegate.swift` chiama
  `FirebaseApp.configure()` PRIMA di avviare React Native e imposta se stesso
  come `UNUserNotificationCenterDelegate` (**l'ordine conta**: è commentato
  nel file, verificato sui sorgenti nativi installati di notifee — se questa
  riga girasse dopo `startReactNative` i banner in primo piano delle nostre
  push smetterebbero di funzionare in silenzio). `Info.plist` ha
  `UIBackgroundModes: [remote-notification]`. `firebase.json` alla radice
  dell'app configura `messaging_ios_foreground_presentation_options` (la leva
  UFFICIALE di RNFirebase per lo stesso problema, ridondante col delegate
  sopra ma più affidabile sotto pnpm — la ricerca di `firebase.json` di
  RNFirebase risale le directory da `node_modules/@react-native-firebase/app`,
  un percorso reso più profondo dalla struttura `.pnpm/`: se in un
  aggiornamento futuro NON trovasse più il file, verificarlo dal log di
  `pod install`, "Using firebase.json from…"). `StubwiseMobile.entitlements`
  ha `aps-environment: development` ed è già collegato via
  `CODE_SIGN_ENTITLEMENTS` nel progetto — Xcode lo promuove da solo a
  `production` in un archivio di distribuzione, non serve un secondo file.
- **Android**: `android/build.gradle` ha il classpath
  `com.google.gms:google-services:4.5.0` (versione allineata a quella che
  RNFirebase stesso raccomanda); `android/app/build.gradle` applica il plugin
  in fondo al file (richiesto da Google). `AndroidManifest.xml` dichiara
  `POST_NOTIFICATIONS` (permesso runtime obbligatorio da Android 13+, richiesto
  da `notifee.requestPermission()` in `OnboardingScreen`).
  ⚠️ **Limite noto v1**: le notifiche FCM (il relay manda un messaggio CON
  `notification`, non data-only — vedi `packages/notifications/src/push/payload.ts`)
  vengono mostrate dal SO automaticamente in background/app chiusa, SENZA
  eseguire codice JS: i bottoni d'azione rapida su Android esistono solo
  quando l'app è già in PRIMO PIANO (`onForegroundEvent` in `lib/push.ts`).
  `index.js` registra comunque `setBackgroundMessageHandler`/
  `notifee.onBackgroundEvent` — pronti per il giorno in cui i messaggi
  diventassero data-only, e già funzionanti per le pressioni su iOS (dove il
  SO instrada le interazioni al delegate installato da notifee indipendentemente
  da come la notifica è stata mostrata).

### Dopo aver aggiunto i file veri

```bash
cd apps/mobile/ios && bundle exec pod install   # legge $RNFirebaseDisableSPM, linka Firebase
pnpm --filter @stubwise/mobile ios --udid <UDID>     # SOLO su device fisico
pnpm --filter @stubwise/mobile android
```

In Xcode, abilitare la capability **Push Notifications** dal tab *Signing &
Capabilities* del target (punta da sé a `StubwiseMobile.entitlements`, già
presente — non ne crea uno nuovo).
