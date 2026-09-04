import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CountsLine } from "./CountsLine";
import { PulseIndicator } from "../PulseIndicator";
import { pulseLineFor } from "../../lib/pulse-line";
import { colors, radii } from "../../theme/tokens";

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
        <PulseIndicator tone={line.tone} text={t(line.key, line.params)} />
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
    marginTop: 8,
  },
  countsWrap: {
    marginTop: 8,
  },
});
