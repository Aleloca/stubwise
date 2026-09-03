import type { ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";
import { StyleSheet, Text } from "react-native";
import { colors } from "../theme/tokens";
import { fontFamily, fontSize } from "../theme/typography";

/**
 * Etichetta mono maiuscola con letter-spacing largo: il vocabolario visivo
 * ricorrente del canvas per gli "eyebrow" ("PASSO 2 DI 2", "SEGUI I
 * PROGETTI") e le intestazioni di sezione dell'inbox ("Ti blocca · 2"). Il
 * testo maiuscolo lo fa `textTransform` qui, non il chiamante: così le
 * stringhe i18n restano leggibili nei file `it.json`/`en.json` invece che
 * scritte tutte maiuscole a mano.
 */
export function SectionLabel({
  children,
  tone = "faint",
  style,
}: {
  children: ReactNode;
  /** `faint` per le annotazioni discrete, `muted` per quelle più prominenti. */
  tone?: "faint" | "muted";
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.base, { color: colors[tone] }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  base: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    fontWeight: "500",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
});
