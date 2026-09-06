import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radii } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * Bottone secondario, bordo sottile senza riempimento: "Più tardi",
 * "Riprova" nel canvas. Stesso tipografia del `PrimaryButton` (mono
 * maiuscolo) ma senza sfondo pieno — la gerarchia è nel peso visivo, non nel
 * font.
 */
export function GhostButton({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.base, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderColor: "#2c3641",
    borderRadius: radii.control,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
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
