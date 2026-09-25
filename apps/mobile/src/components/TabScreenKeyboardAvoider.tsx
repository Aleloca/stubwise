import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";

/**
 * Lo scostamento da dare a `KeyboardAvoidingView` in una schermata DENTRO le
 * schede, col campo di testo in fondo (25 set 2026).
 *
 * Perché NEGATIVO e pari alla barra delle schede: queste schermate scorrono
 * SOTTO la barra (è traslucida), e il campo in fondo porta già un
 * `paddingBottom` che include la sua altezza (`COMPOSER_BASE_BOTTOM_PADDING +
 * tabBarHeight`). Quando la tastiera sale, la barra finisce DIETRO la
 * tastiera: se la schermata si alzasse di tutta l'altezza della tastiera,
 * sopra resterebbe un vuoto alto quanto la barra. Togliendo quell'altezza, il
 * campo si ferma appena sopra la tastiera, col suo respiro di sempre.
 *
 * Una funzione a sé per poterla fissare in un test: Testing Library v14 non
 * espone le prop di un componente (vedi `SheetModal`/la vecchia
 * `SheetBackdrop` per la stessa ragione).
 */
export function tabScreenKeyboardOffset(tabBarHeight: number): number {
  return -tabBarHeight;
}

/**
 * La schermata si solleva sopra la tastiera: il campo di testo in fondo non
 * finisce coperto (25 set 2026, segnalato dal maintainer nella chat del
 * backlog — «la tastiera va sopra l'input»).
 *
 * Per le schermate a pagina intera dentro le schede, col campo IN FONDO: le
 * due chat (backlog e «Chiedi al progetto»). ⚠️ **NON dentro un pannello**:
 * `SheetModal` la tastiera la gestisce da sé, e un `KeyboardAvoidingView` lì
 * raddoppierebbe lo spostamento.
 *
 * Su Android `behavior` resta indefinito: lì la finestra si ridimensiona da
 * sola (`windowSoftInputMode`), e `padding` la spingerebbe su due volte.
 * Provato solo su iOS, come i pannelli.
 */
export function TabScreenKeyboardAvoider({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const tabBarHeight = useBottomTabBarHeight();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={tabScreenKeyboardOffset(tabBarHeight)}
      style={style}
      testID="tab-screen-keyboard-avoider"
    >
      {children}
    </KeyboardAvoidingView>
  );
}
