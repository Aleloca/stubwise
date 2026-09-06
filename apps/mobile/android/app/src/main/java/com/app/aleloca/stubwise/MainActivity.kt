package com.app.aleloca.stubwise

import android.content.Intent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "StubwiseMobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  // Deep link `stubwise://…` (Task 13): `ReactActivity` NON inoltra da sé
  // un nuovo Intent al modulo Linking di RN quando l'activity è già in
  // primo piano (`launchMode="singleTask"` nel manifest la riusa invece di
  // aprirne una seconda) — senza questo override, `Linking.addEventListener
  // ("url", …)` non riceve mai l'evento su un secondo tap del link.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }
}
