import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radii } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

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
    backgroundColor: colors.signal,
    borderRadius: radii.control,
    height: 50,
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.85,
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
