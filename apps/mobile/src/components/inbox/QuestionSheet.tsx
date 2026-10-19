import type { AnswerBody, InboxQuestion, Reader } from "@stubwise/shared";
import { SheetModal } from "../SheetModal";
import { QuestionForm } from "./QuestionForm";

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
 * Sheet della domanda dell'agente (canvas `1d`): il pannello (`SheetModal`) che ospita
 * `QuestionForm` — tutte le opzioni con la loro conseguenza, la consigliata
 * marcata (mai preselezionata), "Altro (testo libero)" quando la domanda lo
 * ammette, conferma esplicita — nessun ottimismo, la scelta è una decisione
 * (vedi `useDecision`).
 *
 * App M3, Fase A: il contenuto (opzioni, invarianti, stato) è stato estratto
 * in `QuestionForm.tsx` (riusato NUDO dalla chat del backlog per le sue
 * domande a bottoni, finché sono esistite: fino al 19 ott 2026; oggi dalla
 * sessione dell'agente, `SessionQuestion`) — qui resta solo il contenitore, coi
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
  return (
    <SheetModal open={visible} onClose={onRequestClose} testID={testID}>
      <QuestionForm
        question={question}
        onSubmit={onSubmit}
        pending={pending}
        disabled={disabled}
        online={online}
        errorMessage={errorMessage}
        testIDPrefix="question-sheet"
      />
    </SheetModal>
  );
}

