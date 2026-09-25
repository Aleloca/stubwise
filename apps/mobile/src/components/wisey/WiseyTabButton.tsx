import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useTabBarHeight } from "../../app/tab-bar-height";
import { colors } from "../../theme/tokens";
import { useWisey } from "./WiseyProvider";
import { WiseySprite } from "./WiseySprite";

/** Il cerchio, bordo ambra compreso (design §11). */
export const WISEY_BUTTON_SIZE_PT = 64;
/** L'anello del colore della barra, FUORI dal bordo, che stacca il cerchio dal contenuto. */
const RING_PT = 4;
/** Il cerchio più il suo anello: è questa la misura che sporge. */
export const WISEY_BUTTON_OUTER_PT = WISEY_BUTTON_SIZE_PT + RING_PT * 2;

/**
 * Di quanto spostare il centro del cerchio rispetto al bordo superiore della
 * barra MISURATA, in punti (positivo = più in alto). Oggi 0: il centro sta sul
 * bordo e il cerchio sporge di metà. ⚠️ Col Liquid Glass di iOS 26 la barra è
 * fluttuante, staccata dal bordo dello schermo: se la misura della libreria
 * non coincide col bordo VISIBILE della capsula, si corregge QUI, una riga.
 */
export const WISEY_BUTTON_OFFSET_PT = 0;

/**
 * IL CERCHIO CHE SPORGE sopra la barra (25 set 2026, design §11): il nostro
 * bottone, posato sopra la barra nativa e centrato sulla terza tab — la tab
 * nativa di Wisey c'è ancora sotto, trasparente e senza titolo, così le altre
 * quattro tengono il loro posto.
 *
 * Dentro, il gufo animato sulla fase dello store (stesse regole della pagina:
 * «fatto» finché non l'hai visto, riduzione del movimento). Il cerchio è
 * SCURO e non ambra pieno: il gufo è ambra e crema, e ci sparirebbe.
 *
 * Il nome per VoiceOver ce l'ha il bottone («Wisey»): risolve il buco del §10,
 * dove la tab nativa senza titolo non ne aveva uno.
 *
 * Si aggancia all'altezza VERA della barra (`useTabBarHeight`, vedi
 * `app/tab-bar-height.tsx`) e non compare finché la barra non è misurata.
 */
export function WiseyTabButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const { phase, wiseyFocused } = useWisey();
  const tabBarHeight = useTabBarHeight();

  if (tabBarHeight === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.anchor, { bottom: tabBarHeight - WISEY_BUTTON_OUTER_PT / 2 + WISEY_BUTTON_OFFSET_PT }]}
      testID="wisey-tab-button-anchor"
    >
      <View style={styles.ring}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.wisey.title")}
          accessibilityState={{ selected: wiseyFocused }}
          onPress={onPress}
          style={[styles.button, wiseyFocused && styles.buttonFocused]}
          testID="wisey-tab-button"
        >
          <WiseySprite phase={phase} size="button" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  ring: {
    backgroundColor: colors.ink900,
    borderRadius: WISEY_BUTTON_OUTER_PT / 2,
    height: WISEY_BUTTON_OUTER_PT,
    padding: RING_PT,
    width: WISEY_BUTTON_OUTER_PT,
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.signalDim,
    borderRadius: WISEY_BUTTON_SIZE_PT / 2,
    borderWidth: 2,
    height: WISEY_BUTTON_SIZE_PT,
    justifyContent: "center",
    width: WISEY_BUTTON_SIZE_PT,
  },
  // A fuoco sulla tab Wisey: bordo più spesso e più vivo, e un alone ambra.
  buttonFocused: {
    borderColor: colors.signal,
    borderWidth: 3,
    shadowColor: colors.signal,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
  },
});
