import { isUnknown, type TranscriptItem } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { InlineMarkdown } from "../InlineMarkdown";
import { SafeMarkdown } from "../SafeMarkdown";
import { ToolCard } from "./ToolCard";

/** Chiave del catalogo per un valore di enum aperto da `readerSchema`: l'ignoto ha la sua voce. */
function key(value: string): string {
  return isUnknown(value) ? "unknown" : value;
}

/**
 * Un elemento della trascrizione di una sessione (gemello di `TranscriptRow`
 * in `apps/web/src/components/agent-session/transcript.tsx`): disegna ciò che
 * `buildTranscript` di `@stubwise/shared` ha già deciso, e basta.
 *
 * La domanda qui è in SOLA LETTURA (testo, alternative, se ha già risposta):
 * quando da qui si può rispondere, la schermata la passa a `SessionQuestion`,
 * che col pannello per rispondere la sostituisce (Task 7).
 *
 * Un intervento NON consegnato (Task A2) dice il perché in una frase intera,
 * sotto il testo, e — se la schermata passa `onResend`, cioè se c'è un campo
 * in cui rimetterlo — offre «Rimanda»: il testo torna nel campo, NON parte da
 * solo (chi scrive decide se e quando). Un motivo ignoto (`readerSchema`) o
 * assente ha la sua frase generica, mai una chiave grezza.
 */
export function TranscriptItemView({
  item,
  live,
  onResend,
}: {
  item: TranscriptItem;
  live: boolean;
  /** Rimette il testo di un intervento non consegnato nel campo (senza inviarlo). */
  onResend?: (text: string) => void;
}) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "segment": {
      const label = t(`mobile.agents.segment.${item.label}`);
      return (
        <View style={styles.divider} accessibilityRole="header" accessibilityLabel={label}>
          <View style={styles.rule} />
          <Text style={styles.dividerLabel}>{label}</Text>
          <View style={styles.rule} />
        </View>
      );
    }
    case "segment_end":
      // Solo un passo andato male merita una riga: la fine normale la dice il divisore dopo.
      if (item.timedOut) return <SystemLine text={t("mobile.agents.segmentEnd.timedOut")} danger />;
      if (item.exitCode !== null && item.exitCode !== 0) {
        return <SystemLine text={t("mobile.agents.segmentEnd.failed")} danger />;
      }
      return null;
    case "text":
      return (
        <View testID={item.live ? `transcript-live-${item.id}` : undefined}>
          <SafeMarkdown>{item.text}</SafeMarkdown>
          {item.live && <View style={styles.cursor} />}
        </View>
      );
    case "tool":
      return <ToolCard item={item} live={live} />;
    case "input": {
      const undelivered = item.status === "undelivered";
      const status = t(`mobile.agents.input.${key(item.status)}`);
      const reason = t(`mobile.agents.input.reason.${item.reason === null ? "unknown" : key(item.reason)}`);
      return (
        <View style={styles.inputRow}>
          <View style={[styles.bubble, undelivered && styles.bubbleUndelivered]} testID={`transcript-input-${item.id}`}>
            <View style={styles.bubbleMeta}>
              <Text style={styles.metaText}>{item.authorName ?? "—"}</Text>
              {item.interrupt && <Text style={styles.metaText}>{t("mobile.agents.inputInterrupt")}</Text>}
              <Text style={[styles.metaText, undelivered && styles.danger]}>{status}</Text>
            </View>
            <Text style={styles.bubbleText}>{item.text}</Text>
            {undelivered && (
              <View style={styles.undelivered}>
                <Text style={styles.reason}>{reason}</Text>
                {onResend !== undefined && (
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => onResend(item.text)}
                    style={({ pressed }) => [styles.resend, pressed && styles.resendPressed]}
                    testID={`transcript-input-resend-${item.id}`}
                  >
                    <Text style={styles.resendLabel}>{t("mobile.agents.input.resend")}</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        </View>
      );
    }
    case "interrupted":
      return <SystemLine text={t("mobile.agents.interrupted")} />;
    case "question":
      return (
        <View style={styles.question} testID={`transcript-question-${item.question.id}`}>
          <Text style={styles.questionTitle}>
            {t("mobile.agents.question.title")}
            {item.question.answered ? ` · ${t("mobile.agents.question.answered")}` : ""}
          </Text>
          <SafeMarkdown question>{item.question.question}</SafeMarkdown>
          {(item.question.options ?? []).map((option, index) => (
            <View key={index} style={styles.optionRow}>
              <Text style={styles.option}>{`${index + 1}. `}</Text>
              <View style={styles.optionText}>
                <InlineMarkdown style={styles.option}>{option.label}</InlineMarkdown>
              </View>
            </View>
          ))}
        </View>
      );
  }
}

function SystemLine({ text, danger }: { text: string; danger?: boolean }) {
  return <Text style={[styles.system, danger && styles.danger]}>{text}</Text>;
}

const styles = StyleSheet.create({
  optionRow: { flexDirection: "row" },
  optionText: { flexShrink: 1 },
  divider: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 8 },
  rule: { backgroundColor: colors.line, flex: 1, height: 1 },
  dividerLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  cursor: { backgroundColor: colors.muted, height: 12, marginTop: 2, opacity: 0.7, width: 6 },
  inputRow: { alignItems: "flex-end" },
  bubble: {
    backgroundColor: colors.ink850,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    maxWidth: "85%",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleUndelivered: { borderColor: colors.danger },
  bubbleMeta: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  undelivered: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 2 },
  reason: { color: colors.danger, flexShrink: 1, fontFamily: fontFamily.sans, fontSize: 13 },
  resend: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  resendPressed: { backgroundColor: colors.ink800 },
  resendLabel: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  metaText: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label },
  bubbleText: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: fontSize.body },
  question: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  questionTitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  option: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 13 },
  system: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
  danger: { color: colors.danger },
});
