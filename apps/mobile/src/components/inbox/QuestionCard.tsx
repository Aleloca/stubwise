import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { QuestionSheet } from "./QuestionSheet";
import { SnoozeSheet } from "./SnoozeSheet";
import { useAnswer, useSnooze } from "../../lib/inbox-mutations";
import { can } from "../../lib/inbox-sections";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface QuestionCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Domanda dell'agente (`job.awaiting_input`, canvas `1b`/`1d`): card
 * collassata con "Rispondi" che apre lo sheet delle opzioni. Il `text` della
 * riga include già la domanda (vedi `inboxItemSchema`), quindi non la
 * ripetiamo: il corpo mostra il testo della notifica, il sottotitolo mono
 * riassume quante opzioni ci sono e quale è consigliata.
 */
export function QuestionCard({ item, projectName }: QuestionCardProps) {
  const { t } = useTranslation();
  const answer = useAnswer();
  const snooze = useSnooze();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const question = item.question;

  const subtitle = (() => {
    if (question === undefined) return null;
    const count = question.options.length;
    const recommended =
      question.recommendedIndex !== undefined &&
      question.recommendedIndex >= 0 &&
      question.recommendedIndex < count
        ? question.options[question.recommendedIndex]
        : undefined;
    if (recommended) {
      return t("mobile.inbox.question.subtitle", { count, label: recommended.label });
    }
    return t("mobile.inbox.question.subtitleNoRecommendation", { count });
  })();

  const buttons = [];
  if (can(item, "answer") && question !== undefined) {
    buttons.push({
      key: "respond",
      label: t("mobile.inbox.actions.respond"),
      emphasis: true,
      onPress: () => setSheetOpen(true),
      testID: "question-card-respond",
    });
  } else if (can(item, "open") && item.url !== undefined) {
    buttons.push({
      key: "open",
      label: t("mobile.inbox.actions.open"),
      emphasis: true,
      onPress: () => void Linking.openURL(item.url as string),
      testID: "question-card-open",
    });
  }
  if (can(item, "snooze")) {
    buttons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "question-card-snooze",
    });
  }

  return (
    <CardShell
      tone="signal"
      kindLabel={t("mobile.inbox.kinds.awaitingInput")}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={buttons.length > 0 ? <CardFooter buttons={buttons} /> : undefined}
      errorMessage={snooze.errorMessage}
      testID="question-card"
    >
      <Text style={styles.text}>{item.text}</Text>
      {subtitle !== null && <Text style={styles.subtitle}>{subtitle}</Text>}

      {question !== undefined && (
        <QuestionSheet
          visible={sheetOpen}
          onRequestClose={() => setSheetOpen(false)}
          question={question}
          onSubmit={(body) => answer.mutate({ id: item.id, body })}
          pending={answer.isPending}
          disabled={answer.disabled}
          online={answer.online}
          errorMessage={answer.errorMessage}
          testID="question-sheet"
        />
      )}

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="question-card-snooze-sheet"
      />
    </CardShell>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.fg,
    fontSize: 15,
    lineHeight: 21,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
});
