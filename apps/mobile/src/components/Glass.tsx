import { BlurView } from "@react-native-community/blur";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { colors } from "../theme/tokens";

/** Il materiale del blur su iOS: scuro e sottile, come i campi delle chat di sistema. */
export const GLASS_BLUR_TYPE = "thinMaterialDark";
/** Il bordo sottile: `lineStrong` al 60% (alfa esadecimale `99`). */
export const GLASS_BORDER_COLOR = `${colors.lineStrong}99`;
/** Android non ha un blur nativo affidabile: `ink900` all'85% (alfa `D9`). */
export const GLASS_ANDROID_BACKGROUND = `${colors.ink900}D9`;

/**
 * Il fondo «di vetro» (9 ott 2026, Task A3) di ciò che sta SOPRA la
 * trascrizione di una sessione: il campo, il «↓» e le barre senza scrittura.
 * La trascrizione ci scorre dietro, come nell'app Claude.
 *
 * - iOS: un `BlurView` nativo (`@react-native-community/blur`, componente
 *   Fabric) dietro il contenuto, a tutta superficie e senza tocchi; con
 *   «Riduci trasparenza» attivo il sistema mostra `ink900` pieno
 *   (`reducedTransparencyFallbackColor`).
 * - Android: nessun blur (quello della libreria passa da una dipendenza
 *   esterna e costa a ogni frame dello scorrimento), un fondo `ink900`
 *   all'~85%.
 *
 * Il ramo di piattaforma si decide al RENDER, non al caricamento del modulo:
 * i test lo cambiano con `jest.replaceProperty(Platform, "OS", …)`. Bordo
 * sottile e `overflow: hidden` qui; raggio, padding e disposizione li dà chi
 * lo usa con `style`. Il blur ha `testID` `<testID>-blur`.
 */
export function Glass({ style, children, testID, ...rest }: ViewProps) {
  const ios = Platform.OS === "ios";
  return (
    <View {...rest} style={[styles.base, !ios && styles.android, style]} testID={testID}>
      {ios && (
        <BlurView
          blurType={GLASS_BLUR_TYPE}
          blurAmount={20}
          reducedTransparencyFallbackColor={colors.ink900}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          testID={testID === undefined ? undefined : `${testID}-blur`}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderColor: GLASS_BORDER_COLOR, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  android: { backgroundColor: GLASS_ANDROID_BACKGROUND },
});
