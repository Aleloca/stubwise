import { isAppBuild } from "../data/build";

/**
 * Qui si può cifrare una credenziale (review M10): nel prototipo sempre; nella
 * build «app» solo dentro il desktop, dove la cifra il main (il ponte
 * `window.stubwise.vault`). Nella build web, servita su `/app`, il ponte non
 * c'è: «New credential» non si offre, la cassaforte si apre sulle pagine web.
 */
export function canEncryptHere(): boolean {
  return !isAppBuild() || typeof window.stubwise?.vault?.create === "function";
}

/** La build «app» aperta in un browser (senza il ponte del desktop). */
export function isWebAppBuild(): boolean {
  return isAppBuild() && typeof window.stubwise?.vault?.create !== "function";
}
