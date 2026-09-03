import type { AgentQuestionOption, AnswerBody, InboxQuestion, Reader } from "@stubwise/shared";
import { ANSWER_TEXT_MAX_CHARS } from "@stubwise/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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

export interface QuestionSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  question: Reader<InboxQuestion>;
  onSubmit: (answer: AnswerBody) => void;
  pending: boolean;
  /** Offline O in volo: disabilita l'invio (vedi `useDecision` in `lib/inbox-mutations.ts`). */
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  testID?: string;
}

/**
 * Sheet della domanda dell'agente (canvas `1d`): tutte le opzioni con la loro
 * conseguenza, la consigliata marcata (mai preselezionata), "Altro (testo
 * libero)" quando la domanda lo ammette, conferma esplicita — nessun
 * ottimismo, la scelta è una decisione (vedi `useDecision`).
 */
export function QuestionSheet({
  visible,
  onRequestClose,
  question,
  onSubmit,
  pending,
  disabled,
  online,
  errorMessage,
  testID,
}: QuestionSheetProps) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<number | "free" | null>(null);
  const [text, setText] = useState("");

  // Riparte da zero ogni volta che lo sheet si apre — non deve sopravvivere
  // scelta di una domanda precedente (stessa cautela della `key` su
  // `QuestionPanel` in `apps/web/src/components/question-panel.tsx`).
  useEffect(() => {
    if (visible) {
      setChoice(null);
      setText("");
    }
  }, [visible, question.questionId]);

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
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} accessibilityLabel={t("mobile.inbox.actions.cancel")} />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled">
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
                    testID={`question-sheet-option-${index}`}
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
                testID="question-sheet-other"
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
                  testID="question-sheet-free-text"
                />
              </View>
            )}

            {!online && (
              <Text style={styles.offlineNotice}>{t("mobile.inbox.offlineAction")}</Text>
            )}
            {errorMessage !== null && (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {errorMessage}
              </Text>
            )}

            <PrimaryButton
              label={online ? t("mobile.inbox.question.submit") : t("mobile.inbox.offlineAction")}
              onPress={submit}
              disabled={!canSubmit || pending}
              testID="question-sheet-submit"
            />
          </ScrollView>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(5,7,10,0.7)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: "85%",
    paddingBottom: 32,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#2c3641",
    borderRadius: 2,
    height: 4,
    marginBottom: 16,
    width: 36,
  },
  question: {
    color: colors.fg,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
  },
  option: {
    borderColor: "#2c3641",
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
    fontSize: 16,
    fontWeight: "600",
  },
  optionConsequence: {
    color: colors.muted,
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
    borderColor: "#2c3641",
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
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
    fontSize: 13,
    marginTop: 12,
  },
});
