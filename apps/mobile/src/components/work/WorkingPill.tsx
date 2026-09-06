import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { PulseIndicator } from "../PulseIndicator";
import { elapsedMinutes } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";

export interface WorkingPillProps {
  /** ISO 8601 — `job.startedAt`. Il chiamante monta questo componente SOLO quando il job è davvero `working`. */
  startedAt: string;
  /** Iniettabile per i test, stesso pattern di `OfflineBanner`. */
  now?: () => number;
}

/**
 * «sta lavorando da N min — ti avviso io» (canvas `2c`, e lo stesso
 * indicatore ricorre nell'anatomia della card d'inbox `1a`): MAI uno spinner
 * infinito — il sistema dichiara che notificherà lui.
 *
 * Composto su `PulseIndicator` (tono `sky`, lo stesso di "sta lavorando" in
 * `PulseRow`/`ProjectDetailScreen`) invece di reimplementare pallino+testo:
 * è esattamente il riuso che il commento su `PulseIndicator.tsx` promette al
 * Task 16. Solo il CONTENITORE a pillola (bordo, sfondo, padding) è proprio
 * di `WorkingPill` — il vocabolario visivo del pallino/testo resta in un
 * posto solo. Pallino statico (niente blink: vedi la nota su `Skeleton.tsx`,
 * stesso principio — un'animazione qui terrebbe viva la suite Jest
 * inutilmente per un dettaglio puramente decorativo).
 */
export function WorkingPill({ startedAt, now = Date.now }: WorkingPillProps) {
  const { t } = useTranslation();
  const minutes = elapsedMinutes(startedAt, now());
  const text = minutes < 1 ? t("mobile.work.workingPillNow") : t("mobile.work.workingPill", { count: minutes });

  return (
    <View style={styles.pill} testID="working-pill">
      <PulseIndicator tone="sky" text={text} />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
