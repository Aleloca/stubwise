import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors, radii } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * L'altezza del bottone principale. Esportata perché `GhostButton`, quando gli
 * sta ACCANTO, deve avere la stessa (vedi la sua prop `besidePrimary`): due
 * numeri scritti a mano in due file divergono al primo ritocco.
 */
export const PRIMARY_BUTTON_HEIGHT = 50;

/**
 * Bottone pieno ambra, mono maiuscolo: "Accedi", "Attiva le notifiche e
 * inizia" nel canvas. `disabled` copre sia il caso "form non valido" sia
 * "richiesta in corso" — la copy del label (es. "Accesso…") la decide chi
 * chiama, questo componente non sa nulla di submit o rete.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  pending = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /**
   * Richiesta in corso (28 set 2026, il merge dall'app): lo spinner al posto
   * dell'etichetta, e il bottone non si preme. L'etichetta resta come nome
   * accessibile, così chi usa un lettore di schermo sa ancora cos'è.
   */
  pending?: boolean;
  testID?: string;
}) {
  const inactive = disabled || pending;
  return (
    <Pressable
      accessibilityLabel={pending ? label : undefined}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.base, disabled && styles.disabled, pressed && !inactive && styles.pressed]}
      testID={testID}
    >
      {pending ? <ActivityIndicator color={colors.ink950} testID={testID !== undefined ? `${testID}-spinner` : undefined} /> : <Text style={styles.label}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    backgroundColor: colors.signal,
    borderRadius: radii.control,
    height: PRIMARY_BUTTON_HEIGHT,
    justifyContent: "center",
  },
  // App M1: stesso stato "premuto" del sito (`active:bg-signal-dim`) — un
  // colore vero, non solo un'opacità abbassata sullo stesso ambra.
  pressed: {
    backgroundColor: colors.signalDim,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    color: colors.ink950,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
