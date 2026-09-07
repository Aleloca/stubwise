import { isUnknown } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { WorkStep, WorkStepId } from "../../lib/timeline";
import { relativeTimeCompact } from "../../lib/format";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Colore FISSO per passo (non per stato `done`/`current`/`future`): il
 * canvas (`jobTimeline` di riferimento) tiene "Domanda risposta" ambra e
 * "Piano approvato" verde ANCHE quando sono `done`, non un grigio uniforme —
 * ogni passo porta il proprio significato. Solo `future` spegne tutto a
 * `faint`, qualunque sia il passo (vedi {@link toneFor}).
 */
const STEP_TONE: Record<WorkStepId, keyof typeof colors> = {
  proposed: "faint",
  questionAnswered: "signal",
  planApproved: "ok",
  working: "sky",
  prReview: "ok",
  release: "faint",
};

function toneFor(step: WorkStep): keyof typeof colors {
  return step.status === "future" ? "faint" : STEP_TONE[step.id];
}

const LABEL_KEY: Record<WorkStepId, string> = {
  proposed: "mobile.work.timeline.proposed",
  questionAnswered: "mobile.work.timeline.questionAnswered",
  planApproved: "mobile.work.timeline.planApproved",
  working: "mobile.work.timeline.working",
  prReview: "mobile.work.timeline.prReview",
  release: "mobile.work.timeline.release",
};

/**
 * Il verdetto della review AI in parole (fase 5). `null` quando non c'è nulla
 * da dire — nessuna review, o una ancora in corso: la riga non mostra
 * un'etichetta vuota.
 *
 * `UNKNOWN` (un verdetto che questa build non conosce, `readerSchema`) NON
 * degrada al valore grezzo né sparisce: dice che una review è stata fatta,
 * senza pretendere di saperne l'esito. Stesso trattamento di `waitingKindKey`
 * in `lib/pulse-line.ts`.
 */
function verdictKey(verdict: WorkStep["verdict"]): string | null {
  if (verdict === null) return null;
  if (isUnknown(verdict)) return "mobile.work.timeline.verdictUnknown";
  return verdict === "approve"
    ? "mobile.work.timeline.verdictApprove"
    : "mobile.work.timeline.verdictRequestChanges";
}

/**
 * "Storia del lavoro" (canvas `2c`/`2d`): i 6 passi umani con rotaia
 * verticale, sempre tutti e 6 — mai nascosti, mai riordinati. Il passo
 * `current` è in grassetto (nessuna animazione: vedi la nota su
 * `Skeleton.tsx`/`WorkingPill.tsx`, "niente skeleton animati… la latenza AI
 * si comunica con le parole, non col movimento" — qui si applica anche al
 * "pulsa piano" del canvas, che sarebbe l'unica animazione decorativa vera
 * di questa schermata).
 */
export function Timeline({ steps }: { steps: WorkStep[] }) {
  const { t } = useTranslation();

  return (
    <View testID="timeline">
      <Text style={styles.title}>{t("mobile.work.timeline.title")}</Text>
      {steps.map((step, index) => {
        const tone = colors[toneFor(step)];
        const last = index === steps.length - 1;
        const relative = step.at ? relativeTimeCompact(step.at) : null;
        const verdict = verdictKey(step.verdict);
        return (
          <View
            key={step.id}
            style={styles.row}
            testID={`timeline-step-${step.id}${step.status === "current" ? "-current" : ""}`}
          >
            {!last && <View style={styles.rail} />}
            <View style={[styles.dot, { backgroundColor: tone }]} />
            <View style={styles.content}>
              <View style={styles.headline}>
                <Text style={[styles.label, { color: tone }, step.status === "current" && styles.labelCurrent]}>
                  {t(LABEL_KEY[step.id])}
                </Text>
                {relative && (
                  <Text style={styles.time} testID={`timeline-step-${step.id}-at`}>
                    {relative.kind === "now" ? t("mobile.work.time.now") : t(`mobile.work.time.${relative.kind}`, { count: relative.count })}
                  </Text>
                )}
                {verdict && (
                  <Text style={styles.verdict} testID={`timeline-step-${step.id}-verdict`}>
                    {t(verdict)}
                  </Text>
                )}
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  row: {
    paddingBottom: 18,
    paddingLeft: 24,
    position: "relative",
  },
  rail: {
    backgroundColor: colors.line,
    bottom: -2,
    left: 5,
    position: "absolute",
    top: 12,
    width: 1,
  },
  dot: {
    borderRadius: 6,
    height: 11,
    left: 0,
    position: "absolute",
    top: 4,
    width: 11,
  },
  content: {
    flex: 1,
  },
  headline: {
    alignItems: "baseline",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    fontWeight: "500",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  labelCurrent: {
    fontFamily: fontFamily.monoSemiBold,
    fontWeight: "600",
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  verdict: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
