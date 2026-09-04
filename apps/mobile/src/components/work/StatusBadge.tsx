import { isUnknown } from "@stubwise/shared";
import type { Unknown, WorkState } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { ColorToken } from "../../theme/tokens";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Etichetta i18n + tono per ognuno degli 11 {@link WorkState} — la stessa
 * mappatura di "Stati di un lavoro" del canvas (`1a`), ricalcata su
 * `WorkState` invece che sull'`AiJobStatus` grezzo (11 voci contro le 9 del
 * canvas: `planning`/`held` non compaiono nella swatch ma esistono
 * nell'enum, quindi hanno un'etichetta propria qui).
 */
const STATUS_META: Record<WorkState, { i18nKey: string; tone: ColorToken }> = {
  proposed: { i18nKey: "mobile.work.status.proposed", tone: "faint" },
  planning: { i18nKey: "mobile.work.status.planning", tone: "sky" },
  held: { i18nKey: "mobile.work.status.held", tone: "signal" },
  waiting_answer: { i18nKey: "mobile.work.status.waitingAnswer", tone: "signal" },
  waiting_approval: { i18nKey: "mobile.work.status.waitingApproval", tone: "signal" },
  working: { i18nKey: "mobile.work.status.working", tone: "sky" },
  pr_ready: { i18nKey: "mobile.work.status.prReady", tone: "ok" },
  done: { i18nKey: "mobile.work.status.done", tone: "ok" },
  failed: { i18nKey: "mobile.work.status.failed", tone: "danger" },
  skipped: { i18nKey: "mobile.work.status.skipped", tone: "faint" },
  rejected: { i18nKey: "mobile.work.status.rejected", tone: "faint" },
};

export interface StatusBadgeProps {
  /**
   * `null` = ticket senza nessun job ancora (mai avviato): stesso testo di
   * `proposed`, il ticket "esiste" e nient'altro. `Unknown` = stato che
   * questa build non conosce (server più nuovo) — mai un valore grezzo
   * mostrato, vedi {@link isUnknown}.
   */
  state: WorkState | Unknown | null;
}

/**
 * Badge di testata della schermata Lavoro (canvas `2c`/`2d`): pallino +
 * etichetta mono maiuscola, bordo sottile — stesso linguaggio visivo dello
 * swatch "Stati di un lavoro" del canvas, non il pallino nudo di
 * `PulseIndicator` (quello è per la riga di polso di Progetti, qui serve il
 * contorno con sfondo che il canvas disegna sull'header di `2c`/`2d`).
 */
export function StatusBadge({ state }: StatusBadgeProps) {
  const { t } = useTranslation();
  const meta = state === null || isUnknown(state) ? null : STATUS_META[state];
  const label = meta ? t(meta.i18nKey) : t(state === null ? "mobile.work.status.proposed" : "mobile.work.status.unknown");
  const tone: ColorToken = meta?.tone ?? "faint";

  return (
    <View style={styles.badge} testID="status-badge">
      <View style={[styles.dot, { backgroundColor: colors[tone] }]} />
      <Text style={[styles.label, { color: colors[tone] }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(24,31,40,0.6)",
    borderColor: colors.line,
    borderRadius: 4,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  dot: {
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
