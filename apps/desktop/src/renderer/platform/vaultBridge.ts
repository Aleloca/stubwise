import { buildTarget, isAppBuild } from "../data/build";

/**
 * Qui si può cifrare una credenziale (review M10): nel prototipo sempre; nella
 * build «app» Electron, dove la cifra il main. Nella build web (`/app`) non
 * ancora: la cifratura nella scheda arriva con la cassaforte nel browser
 * (fase 1). Dal TARGET del build (design §4), mai dal ponte a runtime: questo
 * file entra anche nella build web, che il ponte non deve nominarlo.
 */
export function canEncryptHere(): boolean {
  return !isAppBuild() || buildTarget() === "electron";
}

/** La build «app» servita nel browser (`/app`). */
export function isWebAppBuild(): boolean {
  return isAppBuild() && buildTarget() === "web";
}
