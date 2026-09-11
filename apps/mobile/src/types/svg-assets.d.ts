/**
 * Dichiarazione MINIMA per importare un `.svg` come asset immagine (Task 6,
 * App M1+M2: le icone Material Symbol della tab bar Android,
 * `assets/icons/*.svg`). Metro tratta `.svg` come asset di default
 * (`svg` è nel suo `assetExts` — verificato in `metro-config/src/defaults`,
 * non assunto), esattamente come un `.png`: un `require("*.svg")` produce
 * un `ImageSourcePropType`, non markup SVG — è `react-native-bottom-tabs`
 * (Coil-svg lato Android, verificato nel suo `build.gradle`) a decodificarlo
 * come vettore quando lo riceve come `tabBarIcon`. Stesso principio di
 * `react-native-markdown-display.d.ts` in questa cartella: solo la
 * superficie che serve davvero.
 */
declare module "*.svg" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
