import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CountsLine } from "./CountsLine";
import { pulseLineFor } from "../../lib/pulse-line";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/**
 * UNA riga della lista Progetti (canvas `2a`): nome, il polso in una riga
 * (pallino + testo colorati sul tono di `pulseLineFor`) e la riga mono di
 * conteggi sotto. L'ambra segnala "aspetta te" a colpo d'occhio, prima
 * ancora di leggere il testo — è il punto centrale dello screen, non un
 * dettaglio.
 */
export function PulseRow({
  summary,
  viewerId,
  onPress,
}: {
  summary: Reader<ProjectPulseSummary>;
  viewerId: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const line = pulseLineFor(summary, viewerId);
  const waiting = summary.waitingForYou.length + summary.waitingForOthers.length;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={`pulse-row-${summary.projectId}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>{summary.projectName}</Text>
      </View>
      <View style={styles.pulseRow}>
        <View style={[styles.dot, { backgroundColor: colors[line.tone] }]} />
        <Text style={[styles.pulseText, { color: colors[line.tone] }]}>{t(line.key, line.params)}</Text>
      </View>
      <View style={styles.countsWrap}>
        <CountsLine waiting={waiting} running={summary.running.length} ready={summary.backlogReadyCount} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  pressed: {
    opacity: 0.85,
  },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: colors.fg,
    fontSize: 17,
    fontWeight: "600",
  },
  pulseRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  pulseText: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  countsWrap: {
    marginTop: 8,
  },
});
