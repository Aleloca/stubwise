import type { AnswerBody, InboxQuestion, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { QuestionForm } from "./QuestionForm";
import { colors } from "../../theme/tokens";

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
 * Sheet della domanda dell'agente (canvas `1d`): il Modal che ospita
 * `QuestionForm` — tutte le opzioni con la loro conseguenza, la consigliata
 * marcata (mai preselezionata), "Altro (testo libero)" quando la domanda lo
 * ammette, conferma esplicita — nessun ottimismo, la scelta è una decisione
 * (vedi `useDecision`).
 *
 * App M3, Fase A: il contenuto (opzioni, invarianti, stato) è stato estratto
 * in `QuestionForm.tsx`, riusato NUDO da `BacklogChatScreen` per le domande a
 * bottoni della chat del backlog — qui resta solo il contenitore Modal, coi
 * testID storici (`testIDPrefix="question-sheet"`) per non spostare
 * `QuestionSheet.test.tsx`/`InboxCard.test.tsx`.
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

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} accessibilityLabel={t("mobile.inbox.actions.cancel")} />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled">
            <QuestionForm
              question={question}
              onSubmit={onSubmit}
              pending={pending}
              disabled={disabled}
              online={online}
              errorMessage={errorMessage}
              testIDPrefix="question-sheet"
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
    backgroundColor: colors.lineStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: 16,
    width: 36,
  },
});
