import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radii } from "../theme/tokens";
import { fontFamily } from "../theme/typography";
import { PRIMARY_BUTTON_HEIGHT } from "./PrimaryButton";

/**
 * Bottone secondario, bordo sottile senza riempimento: "Più tardi",
 * "Riprova" nel canvas. Stesso tipografia del `PrimaryButton` (mono
 * maiuscolo) ma senza sfondo pieno — la gerarchia è nel peso visivo, non nel
 * font.
 *
 * ⚠️ **`besidePrimary` quando sta accanto a un `PrimaryButton` nella stessa
 * riga** (24 set 2026). Da solo è alto 44, il principale 50: affiancati non
 * combaciavano — il maintainer l'ha visto in «Add to backlog» / «Cancel»,
 * ed era lo stesso in nove coppie. Da solo resta 44 per scelta del
 * maintainer: si allinea solo dove sta accanto al principale.
 */
export function GhostButton({
  label,
  onPress,
  disabled = false,
  besidePrimary = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Nella stessa riga di un `PrimaryButton`: prende la sua altezza. */
  besidePrimary?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        besidePrimary && styles.besidePrimary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
  },
  besidePrimary: {
    height: PRIMARY_BUTTON_HEIGHT,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
