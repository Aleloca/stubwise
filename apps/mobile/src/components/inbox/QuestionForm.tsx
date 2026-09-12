import type { AgentQuestionOption, AnswerBody, InboxQuestion, Reader } from "@stubwise/shared";
import { ANSWER_TEXT_MAX_CHARS } from "@stubwise/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PrimaryButton } from "../PrimaryButton";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Un'opzione senza etichetta non è cliccabile: non c'è nulla da leggere. */
function isUsable(option: Reader<AgentQuestionOption>): boolean {
  return option.label.trim().length > 0;
}

/**
 * Le opzioni da mostrare, o `null` se l'elenco non è utilizzabile.
 *
 * INVARIANTE — gli indici non si compattano MAI: una sola opzione senza
 * etichetta azzera l'INTERO elenco (bail-out), non solo quella voce. Stessa
 * regola di `usableOptions` in `apps/web/src/components/question-panel.tsx` e
 * per la stessa ragione: l'indice scelto viaggia fino al server, che lo valida
 * per range contro le opzioni DAVVERO persistite — saltare una voce qui
 * disallineerebbe "quale opzione ha toccato l'utente" da "quale indice parte".
 */
function usableOptions(question: Reader<InboxQuestion>): Reader<AgentQuestionOption>[] | null {
  if (question.options.length === 0) return null;
  return question.options.every(isUsable) ? question.options : null;
}

export interface QuestionFormProps {
  question: Reader<InboxQuestion>;
  onSubmit: (answer: AnswerBody) => void;
  pending: boolean;
  /** Offline O in volo: disabilita l'invio (vedi `useDecision` in `lib/inbox-mutations.ts`). */
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  testID?: string;
  /**
   * Prefisso dei testID di opzioni/testo libero/invio. `QuestionSheet` passa
   * `"question-sheet"` per non spostare i testID che i suoi test (e
   * `InboxCard.test.tsx`) già usano; default `"question-form"` per chi monta
   * questo componente direttamente (`BacklogChatScreen`).
   */
  testIDPrefix?: string;
}

/**
 * Contenuto puro di una domanda a bottoni (canvas `1d`): le invarianti che
 * NON vanno mai riscritte — bail-out totale sulle opzioni, consigliata MAI
 * preselezionata, controllo di range su `recommendedIndex`, reset dello stato
 * a ogni domanda diversa (`question.questionId`) — separate dal CONTENITORE
 * che le ospita.
 *
 * Estratto da `QuestionSheet` (App M3, Fase A): quello resta il Modal per la
 * card d'inbox (`job.awaiting_input`), `BacklogChatScreen` lo usa NUDO, in
 * linea nella chat — nessun `Modal`, nessuno `ScrollView` proprio (vive dentro
 * quello del chiamante). Nessuna delle due invarianti sopra è duplicata: sono
 * QUI, una volta sola.
 */
export function QuestionForm({
  question,
  onSubmit,
  pending,
  disabled,
  online,
  errorMessage,
  testID,
  testIDPrefix = "question-form",
}: QuestionFormProps) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<number | "free" | null>(null);
  const [text, setText] = useState("");

  // Riparte da zero a ogni domanda DIVERSA — non deve sopravvivere la scelta
  // fatta su una domanda precedente (stessa cautela di `QuestionPanel` in
  // apps/web/src/components/question-panel.tsx, lì risolta con una `key`).
  useEffect(() => {
    setChoice(null);
    setText("");
  }, [question.questionId]);

  const options = usableOptions(question);
  const allowFreeText = question.allowFreeText;
  const freeSelected = options === null || choice === "free";
  const trimmed = text.trim();
  const canSubmit = !disabled && (freeSelected ? trimmed.length > 0 : typeof choice === "number");

  const recommended =
    options !== null &&
    question.recommendedIndex !== undefined &&
    question.recommendedIndex >= 0 &&
    question.recommendedIndex < options.length
      ? question.recommendedIndex
      : null;

  function submit(): void {
    if (!canSubmit) return;
    if (freeSelected) {
      if (trimmed) onSubmit({ text: trimmed });
      return;
    }
    if (typeof choice === "number") onSubmit({ optionIndex: choice });
  }

  return (
    <View testID={testID}>
      <Text style={styles.question}>{question.question}</Text>

      {options !== null &&
        options.map((option, index) => {
          const isRecommended = index === recommended;
          return (
            <Pressable
              key={index}
              accessibilityRole="radio"
              accessibilityState={{ checked: choice === index, disabled }}
              onPress={() => setChoice(index)}
              style={[styles.option, isRecommended && styles.optionRecommended, choice === index && styles.optionSelected]}
              testID={`${testIDPrefix}-option-${index}`}
            >
              {isRecommended && <Text style={styles.recommendedTag}>{t("mobile.inbox.question.recommended")}</Text>}
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.consequence !== undefined && option.consequence.length > 0 && (
                <Text style={styles.optionConsequence}>{option.consequence}</Text>
              )}
            </Pressable>
          );
        })}

      {allowFreeText && (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: choice === "free", disabled }}
          onPress={() => setChoice("free")}
          style={[styles.option, choice === "free" && styles.optionSelected]}
          testID={`${testIDPrefix}-other`}
        >
          <Text style={styles.optionLabel}>{t("mobile.inbox.question.otherFreeText")}</Text>
        </Pressable>
      )}

      {freeSelected && (
        <View style={styles.freeTextBlock}>
          <Text style={styles.freeLabel}>{t("mobile.inbox.question.freeLabel")}</Text>
          <TextInput
            accessibilityLabel={t("mobile.inbox.question.freeLabel")}
            value={text}
            onChangeText={setText}
            editable={!disabled}
            maxLength={ANSWER_TEXT_MAX_CHARS}
            multiline
            placeholder={t("mobile.inbox.question.freePlaceholder")}
            placeholderTextColor={colors.faint}
            style={styles.freeInput}
            testID={`${testIDPrefix}-free-text`}
          />
        </View>
      )}

      {!online && <Text style={styles.offlineNotice}>{t("mobile.inbox.offlineAction")}</Text>}
      {errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {errorMessage}
        </Text>
      )}

      <PrimaryButton
        label={online ? t("mobile.inbox.question.submit") : t("mobile.inbox.offlineAction")}
        onPress={submit}
        disabled={!canSubmit || pending}
        testID={`${testIDPrefix}-submit`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  question: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
  },
  option: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 8,
    minHeight: 44,
    padding: 14,
  },
  optionRecommended: {
    backgroundColor: "rgba(245,166,35,0.07)",
    borderColor: "rgba(245,166,35,0.55)",
  },
  optionSelected: {
    borderColor: colors.signal,
  },
  recommendedTag: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    marginBottom: 3,
    textTransform: "uppercase",
  },
  optionLabel: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 16,
    fontWeight: "600",
  },
  optionConsequence: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  freeTextBlock: {
    marginTop: 12,
  },
  freeLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  freeInput: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    minHeight: 80,
    padding: 14,
    textAlignVertical: "top",
  },
  offlineNotice: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 12,
  },
});
