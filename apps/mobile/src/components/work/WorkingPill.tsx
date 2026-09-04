import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

const MINUTE = 60_000;

export interface WorkingPillProps {
  /** ISO 8601 — `job.startedAt`. Il chiamante monta questo componente SOLO quando il job è davvero `working`. */
  startedAt: string;
  /** Iniettabile per i test, stesso pattern di `OfflineBanner`. */
  now?: () => number;
}

/**
 * «sta lavorando da N min — ti avviso io» (canvas `2c`, e lo stesso
 * indicatore ricorre nell'anatomia della card d'inbox `1a`): MAI uno spinner
 * infinito — il sistema dichiara che notificherà lui. Pallino statico (niente
 * blink: vedi la nota su `Skeleton.tsx`, stesso principio — un'animazione qui
 * terrebbe viva la suite Jest inutilmente per un dettaglio puramente
 * decorativo).
 */
export function WorkingPill({ startedAt, now = Date.now }: WorkingPillProps) {
  const { t } = useTranslation();
  const minutes = Math.floor(Math.max(0, now() - new Date(startedAt).getTime()) / MINUTE);
  const text = minutes < 1 ? t("mobile.work.workingPillNow") : t("mobile.work.workingPill", { count: minutes });

  return (
    <View style={styles.pill} testID="working-pill">
      <View style={styles.dot} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dot: {
    backgroundColor: colors.sky,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  text: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
