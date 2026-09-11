# @stubwise/mobile

App React Native **bare** (niente Expo) di Stubwise, per iOS e Android.
Bundle id iOS e `applicationId` Android: `com.app.aleloca.stubwise`; nome
visualizzato: **Stubwise**.

Tema, i18n, sessione (Keychain), client HTTP verso `@stubwise/api-client`,
navigazione (`@react-navigation`, deep link `stubwise://…`), login e
onboarding, push (Task 19) — `src/app/App.tsx` è la radice. I quattro tab di
`Main` (Inbox/Progetti/Backlog/Docs, più gli screen di dettaglio raggiunti da
ciascuno) sono completi, non placeholder — vedi il programma "Stubwise Go"
(`docs/plans/2026-09-11-mobile-app-program-design.md`) per lo stato corrente
e cosa resta fuori scope.

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

## Font (IBM Plex Sans/Mono) e tab bar nativa

App M1+M2 (11 set 2026): due font e una dipendenza nativa nuova.

**Font**: `assets/fonts/` porta 8 file TTF — 4 pesi di IBM Plex Sans
(Regular/Medium/SemiBold/Bold, `theme/typography.ts` §`fontFamily`) più i 4
pesi gemelli di Mono, già presenti da prima. Entrambe le famiglie sono build
STATICHE vere del **servizio di download** di Google Fonts (non del repo
sorgente `github.com/google/fonts`, che per Sans pubblica solo il font
variabile — vedi il docblock in `theme/typography.ts` per la verifica),
cablate in iOS e Android con `npx react-native-asset` (`react-native.config.js`,
`assets: ["./assets/fonts"]`). Un cambio ai font va rifatto con lo stesso
comando — **rivedi il diff** dopo: è noto che `react-native-asset` può
silenziosamente eliminare commenti XML preesistenti in `Info.plist`
rigenerandolo (successo reale, Task 2: un commento su `UIBackgroundModes`
sparito e restaurato a mano).

`theme/typography.ts` espone anche `textStyles` — un piccolo insieme di
preset di stile testo condivisi (`screenTitle`/`screenSubtitle`, usati da
`components/ScreenHeader.tsx`): è il posto dove `fontFamily` va cablato per
i titoli di schermata, non ripetuto file per file (la struttura che
l'applicazione più ampia del font dal Task 7 ha reso necessaria).

**Tab bar nativa** (`react-native-bottom-tabs` + `@bottom-tabs/react-navigation`,
Task 6): sostituisce il tab navigator JS-rendered di `@react-navigation/bottom-tabs`.
Nessun passo di build in più oltre al normale `pod install`/Gradle sync — la
libreria porta i propri pod/dipendenze Android (Material3 arriva
transitivamente, verificato nel suo `build.gradle`: nessuna dipendenza nativa
aggiunta a mano). **Richiede Android `AppTheme` su `Theme.Material3.DayNight.NoActionBar`**
(`android/app/src/main/res/values/styles.xml`, già cambiato in questo lavoro)
e **Liquid Glass genuino su iOS 26 arriva SOLO compilando con l'SDK iOS 26**
(nessuna opzione della libreria "abilita il vetro" — è la conseguenza del
build target, verificato leggendo i sorgenti della libreria, non assunto).

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

### Creare il progetto Firebase

Serve UN progetto Firebase, condiviso da iOS e Android (l'app sugli store è
una sola, vedi "Firma (iOS)" sopra sullo stesso ragionamento per il team di
firma). Da [console.firebase.google.com](https://console.firebase.google.com):

1. **Add project** → nome libero (es. "Stubwise") → Google Analytics è
   facoltativo, si può disattivare.
2. **Add app → iOS**: bundle ID `com.app.aleloca.stubwise` (deve combaciare
   con `PRODUCT_BUNDLE_IDENTIFIER` nel pbxproj, vedi "Firma (iOS)"). Al passo
   di download, scarica `GoogleService-Info.plist` — dove piazzarlo è nella
   sezione subito sotto.
3. **Add app → Android**: package name `com.app.aleloca.stubwise` (deve
   combaciare con `namespace`/`applicationId` in `android/app/build.gradle`).
   Scarica `google-services.json`.
4. Cloud Messaging (FCM) è già attivo di default su ogni progetto Firebase
   nuovo: non serve un passo di attivazione separato.

⚠️ **Chi forka il repo deve creare un proprio progetto Firebase**, con le
proprie app iOS/Android sotto il bundle id che sceglie (vedi "Firma (iOS)"):
un progetto Firebase è legato ai bundle id/`applicationId` dichiarati, non è
condivisibile fra due firme diverse.

Il **service account JSON** che serve al relay push (sezione "Il relay push"
più sotto) è un artefatto DIVERSO, dallo stesso progetto: Project settings →
service accounts → **Generate new private key**. `GoogleService-Info.plist` e
`google-services.json` configurano l'SDK client (quest'app); il service
account autentica il relay verso l'API di FCM — non sono intercambiabili.

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
  Su Android FCM (messaggio CON `notification`, non data-only — vedi
  `packages/notifications/src/push/payload.ts`) si comporta diversamente nei
  due stati, verificato sui sorgenti nativi installati di
  `@react-native-firebase/messaging`
  (`ReactNativeFirebaseMessagingReceiver.onReceive`): in BACKGROUND/app chiusa
  il SO la mostra da SOLO, coi soli titolo/corpo (nessuna azione: un canale
  porta volume/importanza, non bottoni — `AndroidChannel` non ha un campo
  `actions`); in PRIMO PIANO il SO non mostra NULLA da sé (il ramo foreground
  del receiver si limita a emettere l'evento JS `onMessage`) — è
  `displayForegroundAndroidNotification` in `lib/push.ts`, agganciata a
  `onMessage`, a ridisegnarla con le azioni di `categoryFor(kind)`.
  ⚠️ **Limite noto v1**: i bottoni d'azione rapida su Android esistono quindi
  SOLO in primo piano; in background la notifica compare ma senza bottoni.
  `index.js` registra comunque `setBackgroundMessageHandler`/
  `notifee.onBackgroundEvent` — pronti per il giorno in cui i messaggi
  diventassero data-only (a quel punto anche il background passerebbe dallo
  stesso ridisegno esplicito, con le azioni). Su iOS il SO mostra già la
  notifica in OGNI stato via APNs (`AppDelegate.willPresent`): `onMessage`
  scatta anche lì per lo stesso push, ma NON viene usato per ridisegnare —
  duplicherebbe la notifica.

### Dopo aver aggiunto i file veri

```bash
cd apps/mobile/ios && bundle exec pod install   # legge $RNFirebaseDisableSPM, linka Firebase
pnpm --filter @stubwise/mobile ios --udid <UDID>     # SOLO su device fisico
pnpm --filter @stubwise/mobile android
```

In Xcode, abilitare la capability **Push Notifications** dal tab *Signing &
Capabilities* del target (punta da sé a `StubwiseMobile.entitlements`, già
presente — non ne crea uno nuovo).

## Distribuzione (Task 22)

⚠️ **Presuppone che la sezione "Push (Task 19)" sopra sia già completata**
(progetto Firebase creato, `GoogleService-Info.plist`/`google-services.json`
piazzati). Non è un blocco tecnico — l'app **compila silenziosamente** anche
senza quei file (vedi "Cosa fa già il codice committato" sopra) — ma un primo
archivio/build che saltasse quel passo produce un binario TestFlight/Play
perfettamente installabile con le push **mute in silenzio**, senza nessun
errore che lo segnali.

Build interne (TestFlight iOS, Play internal/APK Android): niente ancora in
CI (vedi "Nessuna build nativa in CI" nel piano di fase 4 — valutata per la
fase 4b), quindi ogni passo qui sotto è manuale, dalla macchina di chi
rilascia.

### iOS: firma, archivio, TestFlight interno

Presupposti già a posto nel repo (sezione "Firma (iOS)" sopra): team
`6ZQUNJK5N4`, `CODE_SIGN_STYLE = Automatic`, bundle id
`com.app.aleloca.stubwise`. Serve comunque un **Apple Developer Program**
attivo su quel team (App Store Connect, TestFlight).

0. `pnpm install && pnpm -r build` dalla radice, se non l'hai già fatto
   dopo l'ultimo pull: la fase "Bundle React Native code and images"
   dell'archivio risolve `@stubwise/api-client` e `@stubwise/shared` dal
   loro `dist/`, e senza build fallisce con `InvalidPackageError … main
   module field that could not be resolved` (visto al primo archivio
   reale, 6 set 2026). Poi `cd apps/mobile/ios && pod install`.
1. `pnpm --filter @stubwise/mobile version:bump` (vedi sotto) — un archivio
   con un `buildNumber` già usato viene rifiutato da App Store Connect.
2. Apri **`apps/mobile/ios/StubwiseMobile.xcworkspace`** in Xcode — non lo
   `.xcodeproj`: i pod si linkano solo passando dal workspace.
3. Seleziona il target **StubwiseMobile** → tab **Signing & Capabilities**:
   - **Team**: conferma sia quello giusto (o selezionalo, se Xcode l'ha
     smarrito aprendo il progetto su un'altra macchina);
   - verifica che compaiano le capability **Push Notifications** e
     **Background Modes** con **Remote notifications** spuntato — sono già
     nel progetto committato (entitlements + `Info.plist`, vedi sezione
     "Push" sopra), qui si controlla solo che Xcode le stia leggendo.
4. In alto, scegli come destinazione **Any iOS Device (arm64)** — non un
   simulatore: **Product → Archive** è disabilitato finché è selezionato un
   simulatore.
5. **Product → Archive.** A fine build si apre l'**Organizer** con l'archivio
   appena creato.
6. Nell'Organizer, seleziona l'archivio → **Distribute App** → **App Store
   Connect** → **Upload** → lascia **Automatically manage signing** →
   **Upload**. Xcode carica il build su App Store Connect.
7. Attendi l'elaborazione di App Store Connect (email di conferma, di solito
   pochi minuti): in **App Store Connect → app → TestFlight**, il build
   compare sotto "Elaborazione" e poi "Pronto per il test".
8. **TestFlight interno**: nella tab TestFlight, aggiungi il build al gruppo
   **Internal Testing** (fino a 100 tester, membri del team Apple Developer:
   nessuna revisione Apple richiesta, a differenza dell'external testing) →
   i tester ricevono l'invito nell'app **TestFlight** sul loro iPhone.

### Android: keystore, build di release, distribuzione interna

Per default (nessuna keystore di upload configurata) `release` si firma con
la **stessa keystore di debug** dello scaffold React Native — va bene per
`react-native run-android` durante lo sviluppo, MA non per una build
distribuita: prima del primo rilascio reale serve una keystore di upload
propria. Il cablaggio in `build.gradle` (`signingConfigs.release` +
`buildTypes.release.signingConfig`) è già nel repo (review fase 4, finding
#5): l'unico passo che resta è generare la keystore e definire le sue
credenziali.

1. **Genera la keystore** (una volta sola; conservala, non è recuperabile se
   persa — un cambio di keystore blocca gli aggiornamenti in-place su Play):

   ```bash
   cd apps/mobile/android/app
   keytool -genkeypair -v -storetype PKCS12 -keyalg RSA -keysize 2048 \
     -validity 10000 -alias stubwise-upload -keystore stubwise-upload-key.keystore
   ```

   Il file `*.keystore` finisce già escluso da git per costruzione (regola
   `apps/mobile/**/*.keystore` in `.gitignore`, con la sola eccezione di
   `debug.keystore`): nessun rischio a generarlo dentro `android/app/`.

2. **Credenziali FUORI dal repo**: NON in `apps/mobile/android/gradle.properties`
   (quel file è tracciato — ci sono solo flag pubblici come
   `newArchEnabled`). Vanno nel `gradle.properties` **globale della macchina**,
   `~/.gradle/gradle.properties` (crealo se non esiste):

   ```properties
   STUBWISE_UPLOAD_STORE_FILE=/percorso/assoluto/stubwise-upload-key.keystore
   STUBWISE_UPLOAD_KEY_ALIAS=stubwise-upload
   STUBWISE_UPLOAD_STORE_PASSWORD=...
   STUBWISE_UPLOAD_KEY_PASSWORD=...
   ```

3. **Il cablaggio è già in `android/app/build.gradle`** (review fase 4,
   finding #5) — niente da modificare a mano. Definendo le quattro
   proprietà sopra (in `~/.gradle/gradle.properties`, o come variabili
   d'ambiente — lo script le legge in entrambi i modi), `release` si firma
   da sola con la keystore di upload: `hasUploadKeystore` (in cima al file)
   passa da `false` a `true`, `signingConfigs.release` si popola, e
   `buildTypes.release.signingConfig` la usa al posto di `signingConfigs
   .debug`.

   **Senza** quelle quattro proprietà (lo stato di partenza, e quello di chi
   fa solo sviluppo locale), `bundleRelease`/`assembleRelease` continuano a
   funzionare esattamente come lo scaffold originale — firmano con la
   keystore di debug — ma ora lo dicono: un
   `logger.warn("Release firmata con la keystore di DEBUG: …")` compare nel
   log a ogni build di release, invece del vecchio commento nel sorgente che
   nessuno legge finché non è già in produzione. Un binario firmato debug
   comunque non è distribuibile fuori da dispositivi di sviluppo (Play
   Console lo rifiuta come primo upload).

4. **Bump versione, poi build**:

   ```bash
   pnpm --filter @stubwise/mobile version:bump
   cd apps/mobile/android
   ./gradlew bundleRelease    # .aab, per Play — android/app/build/outputs/bundle/release/app-release.aab
   ./gradlew assembleRelease  # .apk diretto — android/app/build/outputs/apk/release/app-release.apk
   ```

5. **Distribuzione**: carica l'`.aab` in Play Console → il tuo app →
   **Testing → Internal testing** → crea una release, aggiungi i tester per
   email (nessuna revisione Google per l'internal testing); oppure, per un
   giro più rapido senza Play Console, condividi direttamente l'`.apk`
   (sideload — il device deve consentire l'installazione da sorgenti non
   verificate).

   ⚠️ **Sul TUO device di sviluppo, non solo su Play, la keystore diversa è
   un problema anche al PRIMO passaggio, non solo nei rilasci futuri.** Se
   quel device/emulatore ha già l'app installata da una build di debug
   (`pnpm --filter @stubwise/mobile android`), installarci sopra l'APK/AAB
   firmato con la keystore di upload fallisce con
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: Android rifiuta un aggiornamento
   in-place quando il certificato di firma cambia, e debug → upload è
   sempre un certificato diverso. Disinstalla prima l'app di debug
   (`adb uninstall com.app.aleloca.stubwise`), poi installa la build
   firmata release.

### Versionare un rilascio: `pnpm --filter @stubwise/mobile version:bump`

Prima di ogni archivio iOS o build Android di rilascio:

1. Alza a mano il campo `"version"` in `apps/mobile/package.json` (semver).
2. Lancia `pnpm --filter @stubwise/mobile version:bump`
   (`apps/mobile/scripts/version-bump.mjs`): legge `version`, calcola il
   prossimo `buildNumber` (persistito nello stesso `package.json`,
   **incrementato a ogni invocazione**, non idempotente), e lo scrive in
   `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` su TUTTI i build config del
   pbxproj iOS e in `versionName`/`versionCode` di
   `android/app/build.gradle`.
3. Solo a quel punto archivia (iOS) o lancia `./gradlew bundleRelease`
   (Android): sia App Store Connect sia Play Console rifiutano un upload col
   build number/versionCode già visto.

⚠️ Lo script non è idempotente **di proposito** (Apple/Google richiedono un
build number monotono a ogni upload, non "impostato"): rilanciarlo due volte
senza un archivio/build in mezzo brucia un numero senza motivo — innocuo, ma
inutile.

## Il relay push

Le notifiche push non partono mai direttamente da un'istanza self-hosted
verso APNs/FCM: passano da un **relay** che gira solo sul nostro VPS
(`apps/push-relay`, servizio `push-relay` nel `docker-compose.yml`, sotto il
profilo `relay`).

### Perché un relay e non ogni istanza con le proprie chiavi

L'app sugli store è UNA sola — la nostra — quindi esiste una sola identità di
publisher Apple/Google, e le chiavi APNs/FCM sono legate a QUELLA identità,
non a un'istanza. Un'istanza self-hosted non potrebbe procurarsi le proprie
chiavi APNs/FCM per la nostra app anche volendo: dovrebbe pubblicare un'app
diversa. Il relay è quindi l'unico modo perché chiunque self-hosti Stubwise
possa comunque mandare push all'app ufficiale ai propri utenti.

### Cosa vede il relay, e cosa no

Ogni istanza gli manda `{ tokens, payload }` via HTTPS (`POST /v1/send`): il
relay vede quindi titolo e corpo delle notifiche di TUTTE le istanze che lo
usano, in transito su TLS, e **non li logga**. È una scelta v1, dichiarata: la
**cifratura end-to-end** (chiave per device, ciphertext attraverso il relay,
decifratura in una Notification Service Extension sul telefono) è pianificata
per la **fase 4b**, non c'è ancora. Chi ha requisiti di riservatezza
stringenti sul CONTENUTO delle notifiche (non sul fatto che ne esistano) lo
tenga presente fino a quel punto.

### Come lo usa un'istanza self-hosted

Un solo env sul **worker**, `PUSH_RELAY_URL`, con tre forme (⚠️ nel compose la
sintassi è `${VAR-default}` col trattino nudo, non `:-`: coi due punti una
stringa vuota in `.env` verrebbe rimpiazzata dal default e le push non si
spegnerebbero mai):

- **assente** → punta al relay pubblico che operiamo noi
  (`https://push.stubwise.aleloca.dev`, `DEFAULT_PUSH_RELAY_URL` in
  `packages/notifications/src/push/config.ts`) — il default, funziona senza
  fare nulla;
- **stringa vuota** (`PUSH_RELAY_URL=`) → push **spente**: il poller marca
  ogni consegna `push` come `skipped` senza contattare nessun relay. È
  l'interruttore del rollback della fase 4 (vedi CLAUDE.md);
- **un URL https** → quel relay (per chi decidesse di operarne uno proprio).

Il device registra il proprio token via `PUT /api/me/devices`
(`platform`/`token`, vedi `apps/server/src/routes/me-prefs.ts`): l'istanza
non vede mai le chiavi APNs/FCM, solo i token dei device dei propri utenti,
che passa al relay a ogni notifica dovuta.

### Come lo operiamo sul nostro VPS

Il relay gira **solo** da noi, dietro `docker compose --profile relay` (senza
quel flag il servizio non si builda né si avvia — vedi il blocco commentato
`push-relay:` in `docker-compose.yml`). Setup:

1. **Credenziali APNs** (necessarie solo se `IOS_PUSH_VIA=apns`; il default
   `fcm` instrada anche i token iOS via Firebase — vedi "Push (Task 19)"
   sopra): da [Apple Developer](https://developer.apple.com/account) →
   **Certificates, Identifiers & Profiles → Keys**, crea una chiave APNs
   (abilita "Apple Push Notifications service"), scarica il file `.p8`
   (scaricabile UNA sola volta), annota il **Key ID** (`APNS_KEY_ID`) e il
   **Team ID** (`APNS_TEAM_ID`, lo stesso `6ZQUNJK5N4` della firma iOS).
   Codifica il `.p8` in base64 su una riga:

   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
   ```

   e mettilo in `APNS_KEY_P8` nel `.env` del VPS, insieme a `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_BUNDLE_ID=com.app.aleloca.stubwise` e `APNS_SANDBOX`
   (nient'altro che `"true"`/`"false"` letterali, il relay rifiuta ogni altra
   forma). ⚠️ **`false` copre sia TestFlight sia App Store**: l'entitlement
   `aps-environment` del progetto è `development` nei sorgenti, ma Xcode lo
   promuove da solo a `production` in OGNI archivio di distribuzione (vedi
   "Push (Task 19)" sopra) — TestFlight non è un ambiente intermedio.
   `APNS_SANDBOX=true` serve solo per un token registrato da un run di
   sviluppo lanciato direttamente da Xcode/`react-native run-ios` su device
   fisico (mai da un archivio).

2. **Credenziali FCM** (sempre obbligatorie: è il canale attivo anche per
   iOS in v1): dalla console Firebase → **Project settings → Service
   accounts → Generate new private key** (JSON), poi:

   ```bash
   base64 -i service-account.json | tr -d '\n'
   ```

   in `FCM_SERVICE_ACCOUNT_JSON` nel `.env` del VPS.

3. **DNS**: un record per `push.<dominio>` (es. `push.stubwise.aleloca.dev`)
   che punti al VPS, e `PUSH_RELAY_HOST=<dominio>` (solo l'host, senza
   `push.`) in `.env` — è quel che monta il blocco Caddy del relay, vedi
   `caddy.d/README.md`. Prima di attivarlo per la prima volta:

   ```bash
   cp caddy.d/relay.caddy.example caddy.d/relay.caddy
   ```

   (il file `.example` non viene mai caricato da Caddy; copiato senza
   suffisso lo attiva — e da quel momento `PUSH_RELAY_HOST` diventa
   obbligatoria, altrimenti Caddy si rifiuta di partire).

4. **Avvio**:

   ```bash
   docker compose --profile relay up -d --build push-relay caddy
   ```

Nessuna porta pubblicata dal relay verso l'host: ci arriva solo Caddy, dalla
rete interna del compose. **Non esporre mai il relay direttamente** (porta
pubblicata, un altro reverse proxy che non riscrive `X-Forwarded-For`): il
rate limit per IP (`apps/push-relay/src/server.ts`, `trustProxy: 1`) si fida
di UN solo hop davanti a sé per calcolare l'IP del client — se quell'hop non
è un proxy fidato che annette l'indirizzo reale (come fa Caddy di default),
un client può scriversi da sé `X-Forwarded-For` e scegliersi un bucket
diverso a ogni richiesta, aggirando il limite.

## Verifica manuale sul telefono (App M1+M2)

**Nessuna build nativa gira in CI, e nessuna è girata nella sessione che ha
scritto questo lavoro**: font, profondità della palette, vetro della tab bar,
contenuto che scorre sotto, e la reale posizione dell'avatar sono cose che
SOLO un telefono vero può confermare. Questo elenco è parte del lavoro dei
Task 6/7, non un extra — vedi anche i due tradeoff espliciti segnalati nel
codice (`app/providers.tsx`, sull'avatar; `screens/docs/AskProjectScreen.tsx`
e `screens/backlog/BacklogChatScreen.tsx`, sulle due chat) che solo qui si
possono davvero giudicare.

Installa un build TestFlight/interno **su device fisico** (le push a parte,
è anche l'unico modo di vedere il vetro reale della tab bar — nessun
simulatore lo rende) e ripeti quanto segue, **due volte**: su un iPhone con
iOS 26 e su un iPhone/Android più vecchio, o un Android qualunque — i due
esiti attesi sono diversi e ENTRAMBI vanno bene, vedi sotto.

### 1. Tab bar (Task 6)

- [ ] **iOS 26**: la barra ha l'aspetto vetro di sistema (Liquid Glass) — non
      un rettangolo opaco a tinta unita. Le sigle/icone del tab ATTIVO sono
      nel colore ambra (`colors.signal`); quelle inattive sono qualunque
      colore il SISTEMA scelga — **non è un bug** se non combacia col resto
      della palette: è documentato che iOS 26 ignora
      `tabBarInactiveTintColor` e nel codice si è scelto di non compensare.
- [ ] **Android / iOS più vecchio**: la barra ha un aspetto Material3
      "accettabile" (non deve essere vetro — non lo è per costruzione), ma
      non deve nemmeno sembrare rotta: sfondo coerente, icone leggibili,
      nessun colore stonato rispetto al resto dell'app.
- [ ] Le **quattro icone** sono quelle giuste e riconoscibili: Inbox (vassoio),
      Progetti (cartella), Backlog (checklist), Docs (libro) — SF Symbol su
      iOS, Material Symbol su Android (icone diverse fra le due piattaforme
      per lo stesso tab: è previsto, non un difetto).
- [ ] Le **sigle mono** (INB/PRJ/BLG/DOC) sono ANCORA visibili come etichetta
      di ogni tab, insieme all'icona — non una al posto dell'altra.
- [ ] Il **badge dei non letti** sull'Inbox appare quando ci sono voci non
      lette e sparisce quando la inbox è vuota (non un badge fantasma "0").
- [ ] **Contenuto sotto la barra**: apri l'Inbox con abbastanza card da
      riempire lo schermo, scorri fino in fondo — l'**ULTIMA riga** deve
      diventare completamente visibile (non tagliata a metà dal vetro/dalla
      barra), e ci deve essere uno spazio ragionevole sotto, non né zero né
      eccessivo. Ripeti su Backlog (lista voci) e, se ci sono abbastanza
      progetti, su Progetti.

### 2. Chrome globale: avatar e banner offline (Task 7 + fix di review Task 2)

Fix di review (11 set 2026): l'avatar NON scorre più via col contenuto —
ogni schermata post-login (le due chat comprese) usa `stickyHeaderIndices`
(o un header fisso, per le chat) così le Impostazioni restano a un gesto da
qualunque posizione di scorrimento. Verifica che sia vero davvero, non solo
a teoria:

- [ ] All'apertura di un tab (Inbox/Progetti/Backlog/Docs) O di una
      schermata di dettaglio (Dettaglio progetto, Lavoro, Pagina Docs,
      Dettaglio voce di backlog, Card d'inbox), l'**avatar** (cerchio con
      l'iniziale dell'email) è visibile SENZA scorrere.
- [ ] Tocca l'avatar: si apre la sheet **Impostazioni**, con "Esci" raggiungibile.
- [ ] **Scorri una lista/pagina lunga** (Inbox con molte card, o una pagina
      Docs lunga) fino in fondo: l'avatar deve **restare visibile** (ancorato
      in cima, il resto scorre sotto) — non deve sparire scorrendo. Se in un
      punto qualunque risultasse scorso via, è una regressione, non un
      tradeoff accettato.
- [ ] **Le due chat** (Chiedi al progetto, Raffina in chat): l'header con
      l'avatar è fisso fin dall'apertura (non serve nemmeno scorrere per
      verificarlo) — controlla comunque che sia lì.
- [ ] **Banner offline**: disattiva la rete (modalità aereo). Il banner
      "Offline" compare ANCORATO in cima allo schermo, sopra tutto il resto
      — e resta fermo se scorri il contenuto sotto (non scompare scorrendo).
      Riattiva la rete: il banner sparisce.

### 3. Font (Task 2 + Task 7 + fix di review Task 1)

Su OGNI schermata elencata sotto, il **titolo grande** deve essere IBM Plex
Sans **Bold** — visibilmente più squadrato/moderno del sans di sistema
(SF Pro su iOS, Roboto su Android), non lo stesso font di prima:

- [ ] Inbox — titolo "Inbox"
- [ ] Progetti — titolo "Progetti"
- [ ] Backlog — titolo "Backlog"
- [ ] Docs — titolo "Documentazione" (o equivalente i18n)
- [ ] Dettaglio progetto — nome del progetto
- [ ] Lavoro (ticket) — titolo del ticket
- [ ] Dettaglio voce di backlog — titolo della voce
- [ ] Pagina Docs — titolo della pagina

Fix di review (11 set 2026): prima il Sans copriva solo questi otto titoli,
il resto del testo restava nel sans di sistema. Ora anche il **testo lungo**
deve essere IBM Plex Sans, verificalo su almeno questi tre — il caso peggiore
segnalato in review era `theme/markdown.ts`:

- [ ] Un **brief/documento Docs** aperto (testo lungo, non solo il titolo).
- [ ] Un **documento di una voce di backlog** (Dettaglio voce di backlog).
- [ ] Una **risposta della chat** ("Chiedi al progetto" o "Raffina in chat"),
      inclusi eventuali blocchi di codice inline nella risposta — ora Mono
      apposta, a differenza del resto del testo.

Le **sigle mono** (badge, etichette maiuscole, sigle tab, metadati) restano
nel font Mono di prima — non devono essere cambiate.

### 4. Profondità delle superfici (Task 1)

- [ ] Tieni premuto un bottone footer di una card Inbox (es. "Rinvia"): lo
      sfondo premuto deve avere una tinta chiaramente più chiara della card
      (non impercettibile) — è `ink-850`.
- [ ] Tieni premuto il bottone primario (ambra) di una schermata (es. "Procedi"
      su una voce di backlog pronta): lo sfondo premuto deve scurirsi verso
      un ambra spento (`signal-dim`), non restare invariato né sparire del
      tutto.

### 5. Le due chat (eccezione deliberata, Task 7)

- [ ] Apri "Chiedi al progetto" (da Docs) o "Raffina in chat" (da una voce di
      Backlog): scorri i messaggi. Header (titolo/indietro) e il campo di
      scrittura in fondo **restano fermi** mentre scorri — a differenza delle
      altre schermate. È voluto (vedi il commento nel codice): conferma solo
      che non sia fastidioso o che il campo di scrittura non finisca
      nascosto sotto la tab bar.

### 6. Colori base (Task 1, di passaggio)

- [ ] Nessuna schermata ha un colore visibilmente "sbagliato" — sfondo,
      bordi e testo restano nella stessa palette scura del resto dell'app
      (nessuna sorpresa attesa qui: è un refactor a valore invariato, ma è
      l'unica verifica reale che il token giusto sia finito nel posto giusto).

### 7. Rischi noti SOLO su Android (Task 6 — fix di review Task 5)

Due cose che il Task 6 (tab bar nativa + `AppTheme` passato a Material3) può
rompere silenziosamente solo su Android e che nessun test automatico copre —
**non correggerle alla cieca**: verifica prima se il problema si presenta
davvero, sul device reale, prima di cambiare codice.

- [ ] **Lo `Switch` nativo** (Impostazioni → notifiche push): `AppTheme` è
      passato da `Theme.AppCompat.DayNight.NoActionBar` a
      `Theme.Material3.DayNight.NoActionBar` (Task 6) per la tab bar nuova —
      e quel tema è quello dell'intera Activity, quindi lo `Switch` di React
      Native (che delega allo stile nativo) può cambiare aspetto (track/thumb
      Material3 invece di AppCompat). Verifica solo che resti leggibile e
      coerente con la palette scura dell'app — un aspetto diverso ma pulito
      NON è un difetto.
- [ ] **Le icone SVG della tab bar su Android**: Metro tratta `.svg` come
      asset immagine (non markup, vedi `types/svg-assets.d.ts`), e
      `react-native-bottom-tabs` le decodifica via Coil-svg. Verifica che le
      quattro icone (Inbox/Progetti/Backlog/Docs) siano davvero icone
      renderizzate — non un riquadro vuoto o un placeholder rotto: sarebbe il
      caso in cui la rasterizzazione SVG fallisse silenziosamente su un
      device/versione Android specifica, senza errore visibile altrove.

## Troubleshooting

La maggior parte dei problemi noti è già coperta più sopra, con la causa
verificata:

- **`Cannot find module '@stubwise/shared'`** (Metro o Jest) → i package del
  workspace non sono buildati: "Il build di `packages/*` non è opzionale".
- **Red screen su moduli nativi inesistenti** → Metro sta servendo il bundle
  di un ALTRO progetto sulla porta 8081: "Porta di Metro".
- **App compila ma nessun token push arriva mai** → mancano
  `GoogleService-Info.plist`/`google-services.json`, o sono a posto ma
  l'eccezione di `FirebaseApp.configure()` non è stata vista (solo su iOS, a
  runtime): "File di chiavi (NON nel repo)".
- **Le push non arrivano affatto sul simulatore** → per costruzione: APNs
  non consegna ai simulatori. Serve un device fisico, vedi "Scegliere il
  device o il simulatore".
- **`adb install`/l'installazione sul device fallisce con
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`** → il device ha ancora l'app di
  debug installata, firmata con un certificato diverso da quello di upload:
  disinstallala prima (`adb uninstall com.app.aleloca.stubwise`), vedi
  "Android: keystore, build di release, distribuzione interna" sopra.
- **Dopo `git pull`/cambio branch, l'app iOS non builda più** (simboli
  mancanti, pod introvabili) → rifai `cd ios && bundle exec pod install`: un
  `Podfile.lock` cambiato non si applica da solo.
- **`pod install` non trova un pod nuovo dopo aver aggiunto una dipendenza
  nativa** → `bundle exec pod install` di nuovo (non `pod install` col
  CocoaPods di sistema: si perderebbe il pin del `Gemfile`, vedi
  "Prerequisiti").
- **Archivio Xcode disabilitato (grigio)** → la destinazione selezionata è
  un simulatore: seleziona **Any iOS Device (arm64)** prima di **Product →
  Archive**.
- **Upload App Store Connect rifiutato, build number già usato** → manca il
  passo `pnpm --filter @stubwise/mobile version:bump` prima dell'archivio.
