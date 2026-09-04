import { Pressable, StyleSheet, Text, View } from "react-native";
import { SectionLabel } from "../SectionLabel";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

export interface ProjectGroupRowProps {
  /** Testo primario della riga (titolo del ticket, o un riassunto quando non c'è un singolo elemento). */
  title: string;
  /** Testo mono secondario, a destra (stato, ruolo di chi sblocca, azione…). */
  trailing?: string;
  /** Tono di `trailing` — ambra per l'azione che il viewer può fare ("Rispondi ›"). */
  trailingTone?: "amber" | "muted";
  onPress?: () => void;
  testID?: string;
  key: string;
}

/**
 * UN gruppo del dettaglio progetto (canvas `2b`): etichetta di sezione con
 * conteggio + una card che raccoglie le sue righe. `rows` è un ARRAY
 * (come `buttons` di `CardFooter` in `components/inbox/CardShell.tsx`) e
 * non `children`, di proposito: è l'unico modo di sapere qual è la prima
 * riga per disegnare il bordo FRA le righe ma non prima della prima —
 * `index > 0`, esattamente come lì.
 *
 * `amber` è SOLO per "Aspetta qualcuno": è l'unico gruppo il cui colore
 * ambra fa parte del significato ("qualcuno sta aspettando"), non
 * un'enfasi decorativa.
 */
export function ProjectGroup({ label, amber = false, rows }: { label: string; amber?: boolean; rows: ProjectGroupRowProps[] }) {
  return (
    <View style={styles.group}>
      <SectionLabel style={amber ? styles.labelAmber : undefined}>{label}</SectionLabel>
      <View style={styles.card}>
        {rows.map((row, index) => {
          const content = (
            <View style={[styles.row, index > 0 && styles.rowSeparator]}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {row.title}
              </Text>
              {row.trailing !== undefined && (
                <Text style={[styles.rowTrailing, row.trailingTone === "amber" && styles.rowTrailingAmber]}>
                  {row.trailing}
                </Text>
              )}
            </View>
          );
          if (!row.onPress) {
            return (
              <View key={row.key} testID={row.testID}>
                {content}
              </View>
            );
          }
          return (
            <Pressable key={row.key} onPress={row.onPress} accessibilityRole="button" testID={row.testID}>
              {content}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: 8,
  },
  labelAmber: {
    color: colors.signal,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowSeparator: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  rowTitle: {
    color: colors.fg,
    flex: 1,
    fontSize: 14,
  },
  rowTrailing: {
    color: colors.faint,
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  rowTrailingAmber: {
    color: colors.signal,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
