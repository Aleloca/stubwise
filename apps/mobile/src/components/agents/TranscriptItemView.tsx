import { isUnknown, type TranscriptItem } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { collapsedHead, LONG_TEXT_CHARS, liveTail } from "../../lib/transcript-text";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { InlineMarkdown } from "../InlineMarkdown";
import { SafeMarkdown } from "../SafeMarkdown";
import { ToolCard } from "./ToolCard";

/** Quanti caratteri del messaggio entrano nel nome accessibile di «Rimanda». */
const RESEND_EXCERPT = 40;

/**
 * L'inizio di un messaggio, per dire a un lettore di schermo QUALE «Rimanda»
 * è (più bolle non consegnate avrebbero tutte lo stesso nome): spazi
 * compattati, tagliato a {@link RESEND_EXCERPT} caratteri con «…».
 */
export function resendExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESEND_EXCERPT ? `${flat.slice(0, RESEND_EXCERPT).trimEnd()}…` : flat;
}

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
 *
 * Coda e «Ferma» (Q3): un intervento `queued` (scritto all'agente e non ancora
 * preso, regola 8 di `buildTranscript`) dice «In coda» al posto dello stato;
 * uno «Ferma» senza testo (`stop`) è una riga «X ha fermato l'agente», mai
 * una bolla vuota.
 */
export function TranscriptItemView({
  item,
  live,
  onResend,
  resendDisabled = false,
}: {
  item: TranscriptItem;
  live: boolean;
  /** Rimette il testo di un intervento non consegnato nel campo (senza inviarlo). */
  onResend?: (text: string) => void;
  /** Un invio è in corso: il campo sta per svuotarsi, «Rimanda» aspetta. */
  resendDisabled?: boolean;
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
      if (item.live) {
        // Il testo dal vivo cambia ogni ~200 ms: testo semplice, solo la coda.
        // Il markdown arriva col messaggio completo.
        const tail = liveTail(item.text);
        return (
          <View testID={`transcript-live-${item.id}`}>
            <Text style={styles.liveText}>{tail.cut ? `…${tail.text}` : tail.text}</Text>
            <View style={styles.cursor} />
          </View>
        );
      }
      return <AgentText text={item.text} />;
    case "tool":
      return <ToolCard item={item} live={live} />;
    case "input": {
      const undelivered = item.status === "undelivered";
      if (item.stop ?? false) {
        const who =
          item.authorName !== null
            ? t("mobile.agents.input.stopped", { name: item.authorName })
            : t("mobile.agents.input.stoppedGeneric");
        // Consegnato è il caso normale: lo stato si dice solo quando non lo è.
        const suffix = item.status === "delivered" ? "" : ` · ${t(`mobile.agents.input.${key(item.status)}`)}`;
        return <SystemLine text={`${who}${suffix}`} danger={undelivered} />;
      }
      const status = (item.queued ?? false)
        ? t("mobile.agents.input.queued")
        : t(`mobile.agents.input.${key(item.status)}`);
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
                    accessibilityHint={t("mobile.agents.input.resendHint", { text: resendExcerpt(item.text) })}
                    accessibilityState={{ disabled: resendDisabled }}
                    disabled={resendDisabled}
                    hitSlop={8}
                    onPress={() => onResend(item.text)}
                    style={({ pressed }) => [
                      styles.resend,
                      pressed && !resendDisabled && styles.resendPressed,
                      resendDisabled && styles.resendDisabled,
                    ]}
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
    case "question": {
      const q = item.question;
      // La risposta data la manda il server (`answer`): un server più vecchio
      // non la manda, e allora resta la sola dicitura «Risposta data».
      const answer = q.answered ? (q.answer ?? null) : null;
      const chosen = answer !== null && "optionIndex" in answer ? answer.optionIndex : null;
      const freeText = answer !== null && "text" in answer ? answer.text : null;
      const status = !q.answered
        ? ""
        : ` · ${(q.dismissed ?? false) ? t("mobile.agents.question.dismissed") : t("mobile.agents.question.answered")}`;
      return (
        <View style={styles.question} testID={`transcript-question-${q.id}`}>
          <Text style={styles.questionTitle}>
            {t("mobile.agents.question.title")}
            {status}
          </Text>
          <SafeMarkdown question>{q.question}</SafeMarkdown>
          {(q.options ?? []).map((option, index) => {
            const isChosen = index === chosen;
            return (
              <View
                key={index}
                accessibilityState={isChosen ? { selected: true } : undefined}
                style={[styles.optionRow, isChosen && styles.optionChosen]}
                testID={isChosen ? `transcript-question-${q.id}-chosen` : undefined}
              >
                <Text style={[styles.option, isChosen && styles.optionChosenText]}>{`${index + 1}. `}</Text>
                <View style={styles.optionText}>
                  <InlineMarkdown style={[styles.option, isChosen && styles.optionChosenText]}>
                    {option.label}
                  </InlineMarkdown>
                  {isChosen && <Text style={styles.chosenTag}>{t("mobile.agents.question.chosen")}</Text>}
                </View>
              </View>
            );
          })}
          {freeText !== null && (
            <Text style={styles.freeAnswer} testID={`transcript-question-${q.id}-free-text`}>
              {t("mobile.agents.question.freeText", { text: freeText })}
            </Text>
          )}
        </View>
      );
    }
  }
}

/**
 * Un messaggio completo dell'agente. Oltre {@link LONG_TEXT_CHARS} si apre
 * chiuso: il markdown di un documento intero (un agente Docs ne scrive da
 * 100 KB e più) blocca lo scorrimento, e su un telefono quasi mai lo si legge
 * tutto. «Mostra tutto» lo apre, «Mostra meno» lo richiude.
 */
function AgentText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_TEXT_CHARS;
  return (
    <View>
      <SafeMarkdown>{long && !expanded ? collapsedHead(text) : text}</SafeMarkdown>
      {long && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((v) => !v)}
          style={({ pressed }) => [styles.expand, pressed && styles.resendPressed]}
          testID="transcript-text-expand"
        >
          <Text style={styles.resendLabel}>
            {expanded
              ? t("mobile.agents.text.showLess")
              : t("mobile.agents.text.showAll", { count: text.length.toLocaleString() })}
          </Text>
        </Pressable>
      )}
    </View>
  );
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
  liveText: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: fontSize.body },
  expand: {
    alignSelf: "flex-start",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
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
  resendDisabled: { opacity: 0.5 },
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
  // La scelta fatta: lo stesso segnale della scelta selezionata in `QuestionForm`
  // (bordo `signal`) e della sua etichetta in mono maiuscolo.
  optionChosen: {
    borderColor: colors.signal,
    borderRadius: radii.control,
    borderWidth: 1,
    marginHorizontal: -6,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  optionChosenText: { color: colors.fg },
  chosenTag: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    marginTop: 2,
    textTransform: "uppercase",
  },
  freeAnswer: { color: colors.signal, fontFamily: fontFamily.sans, fontSize: 13, marginTop: 4 },
  system: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
  danger: { color: colors.danger },
});
