import { StyleSheet, Text, View } from "react-native";
import type { ColorToken } from "../theme/tokens";
import { colors, radii } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * Pillola mono per una cifra o una sigla breve: il conteggio non letto sul
 * tab Inbox (badge sul tab INB) e — riuso dello stesso linguaggio visivo —
 * le sigle `INB`/`PRJ`/`BLG`/`DOC` quando serve renderle fuori dalla tab bar
 * nativa (App M1+M2, Task 6: `react-native-bottom-tabs` +
 * `@bottom-tabs/react-navigation`, che ha il proprio meccanismo nativo sia
 * di badge — `tabBarBadge` — sia di etichetta — `tabBarLabel`, dove le
 * sigle vivono ora). Non è quel meccanismo nativo: è la versione "disegnata
 * a mano" per dove serve un badge dentro il flusso normale del layout.
 */
export function MonoBadge({
  children,
  tone = "signal",
}: {
  children: string;
  tone?: Extract<ColorToken, "signal" | "danger" | "ok" | "sky" | "violet" | "muted">;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: colors[tone] }]}>
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: "center",
    borderRadius: radii.card,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  text: {
    // Il testo sulla pillola è sempre su sfondo pieno e chiaro (signal/ok/…):
    // ink-950 dà il contrasto migliore, lo stesso schema del bottone
    // primario nel canvas.
    color: colors.ink950,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
  },
});
