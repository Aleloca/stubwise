/**
 * Dichiarazione MINIMA per importare un `.png` come asset immagine (25 set
 * 2026, Wisey: gli sprite del gufo e l'icona della tab). Gemella di
 * `svg-assets.d.ts` qui accanto, stesso principio: Metro tratta `.png` come
 * asset, un import produce un `ImageSourcePropType`, e sceglie da sé il file
 * `@2x`/`@3x` giusto per lo schermo.
 */
declare module "*.png" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
