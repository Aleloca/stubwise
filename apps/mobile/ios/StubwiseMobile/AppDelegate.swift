import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Task 19 (push): PRIMA di avviare React Native, non dopo — `getMessaging()`
    // lato JS presume un'app Firebase già configurata, e senza
    // `GoogleService-Info.plist` nel bundle questa chiamata solleva
    // un'eccezione ("no default app") che React Native non intercetterebbe.
    // Il file NON è nel repo (nessuna chiave reale in questo ambiente): va
    // aggiunto a Xcode (trascinato nel target, "Copy items if needed") prima
    // di poter buildare — vedi README.
    FirebaseApp.configure()

    // I banner in PRIMO PIANO sono OFF di default su iOS: senza un delegate
    // che risponde a `willPresent`, una push che arriva ad app aperta non
    // mostra nulla (né notifee né RNFirebase impostano questo delegate da
    // soli — è responsabilità dell'app, per lasciarle la scelta di COSA
    // mostrare in foreground).
    //
    // ⚠️ L'ORDINE CONTA, verificato sui sorgenti installati. Notifee installa
    // il PROPRIO delegate più tardi, ma NON "dentro `startReactNative`": è un
    // observer NSNotificationCenter registrato a `+load` (process load time,
    // prima di `main()`) su `UIApplicationDidFinishLaunchingNotification` —
    // la notifica che UIKit posta DOPO che questo metodo ha fatto `return`
    // (`NotifeeCore+NSNotificationCenter.m`, `observe`/`+load`, che al
    // trigger chiama `[NotifeeCoreUNUserNotificationCenter observe]` in
    // `NotifeeCore+UNUserNotificationCenter.m`), catturando `center.delegate`
    // DI QUEL MOMENTO come `_originalDelegate` e inoltrandogli `willPresent`/
    // `didReceiveNotificationResponse` quando la notifica non è "sua"
    // (nessun `kNotifeeUserInfoNotification` nello `userInfo` — il caso di
    // OGNI push FCM: le nostre non passano da `notifee.displayNotification`).
    // La riga sotto gira comunque PRIMA (siamo ancora dentro
    // `didFinishLaunchingWithOptions`, che deve fare `return` prima che la
    // notifica parta): se finisse DOPO il `return` di questo metodo, notifee
    // catturerebbe `nil` come delegate originale e le nostre push non
    // avrebbero MAI un banner in foreground — silenziosamente, senza errori.
    // Le pressioni sui
    // bottoni (`didReceiveNotificationResponse`) sono al sicuro in ENTRAMBI
    // gli ordini: quando `_originalDelegate` non implementa quel metodo (qui
    // non lo implementiamo — vedi sotto), notifee ricade su un parsing
    // proprio del payload di sistema e l'evento arriva comunque a
    // `onForegroundEvent`/`onBackgroundEvent`.
    UNUserNotificationCenter.current().delegate = self

    // Dall'SDK di iOS 27 un'app parte solo col ciclo di vita a scene
    // (UIScene): qui si prepara React Native, la finestra la crea il
    // SceneDelegate (Info.plist › UIApplicationSceneManifest).
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
  }

  // Mostra la notifica (banner + suono + badge) anche quando l'app è già in
  // PRIMO PIANO. Senza questo, `notifee.onForegroundEvent`/`handlePushAction`
  // (`src/lib/push.ts`) restano comunque raggiungibili al tap — ma senza
  // banner l'utente non saprebbe che c'è qualcosa su cui tappare.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound, .badge])
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate,
          let factory = app.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Alcune librerie leggono ancora `delegate.window`.
    app.window = window

    // Deep link `stubwise://…` ad app CHIUSA: con le scene l'URL arriva qui,
    // non nelle launchOptions di `didFinishLaunching`. `Linking.getInitialURL`
    // (`src/app/linking.ts`) lo legge dalle launchOptions passate a React
    // Native, quindi lo rimettiamo lì sotto la chiave che RN cerca.
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }

    factory.startReactNative(
      withModuleName: "StubwiseMobile",
      in: window,
      launchOptions: launchOptions
    )
  }

  // Deep link `stubwise://…` ad app APERTA (Task 13): con le scene iOS non
  // chiama più `application(_:open:options:)`, e senza questo inoltro
  // `addEventListener("url", …)` resterebbe muto.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
