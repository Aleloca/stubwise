import type { AnswerBody, InboxQuestion, Reader } from "@stubwise/shared";
import { fireEvent, render, screen } from "@testing-library/react-native";
import "../../i18n";
import { QuestionSheet } from "./QuestionSheet";

const QUESTION: Reader<InboxQuestion> = {
  questionId: "q-1",
  round: 1,
  question: "Il reso parziale può superare l'importo pagato?",
  options: [
    { label: "Blocca al totale pagato", consequence: "Nessun rischio contabile." },
    { label: "Consenti oltre, con avviso" },
  ],
  recommendedIndex: 0,
  allowFreeText: true,
};

async function renderSheet(overrides: Partial<React.ComponentProps<typeof QuestionSheet>> = {}) {
  const onSubmit = jest.fn<void, [AnswerBody]>();
  const onRequestClose = jest.fn();
  await render(
    <QuestionSheet
      visible
      onRequestClose={onRequestClose}
      question={QUESTION}
      onSubmit={onSubmit}
      pending={false}
      disabled={false}
      online
      errorMessage={null}
      {...overrides}
    />,
  );
  return { onSubmit, onRequestClose };
}

describe("QuestionSheet", () => {
  test("nascosto quando visible=false: nessuna opzione nell'albero", async () => {
    await render(
      <QuestionSheet
        visible={false}
        onRequestClose={jest.fn()}
        question={QUESTION}
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage={null}
      />,
    );
    expect(screen.queryByText(QUESTION.question)).toBeNull();
  });

  test("mostra le opzioni con la conseguenza e marca la consigliata", async () => {
    await render(
      <QuestionSheet
        visible
        onRequestClose={jest.fn()}
        question={QUESTION}
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage={null}
      />,
    );
    expect(screen.getByText(QUESTION.question)).toBeTruthy();
    expect(screen.getByText("Blocca al totale pagato")).toBeTruthy();
    expect(screen.getByText("Nessun rischio contabile.")).toBeTruthy();
    expect(screen.getByText("Consigliata")).toBeTruthy();
    expect(screen.getByText("Altro (testo libero)")).toBeTruthy();
  });

  test("scegliere un'opzione e inviare chiama onSubmit con optionIndex", async () => {
    const { onSubmit } = await renderSheet();
    await fireEvent.press(screen.getByTestId("question-sheet-option-1"));
    await fireEvent.press(screen.getByTestId("question-sheet-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ optionIndex: 1 });
  });

  test("'Altro' + testo libero e inviare chiama onSubmit con text", async () => {
    const { onSubmit } = await renderSheet();
    await fireEvent.press(screen.getByTestId("question-sheet-other"));
    await fireEvent.changeText(screen.getByTestId("question-sheet-free-text"), "Rispondo a modo mio");
    await fireEvent.press(screen.getByTestId("question-sheet-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ text: "Rispondo a modo mio" });
  });

  // Mutazione da rompere apposta: se `usableOptions` scartasse SOLO la voce
  // senza etichetta invece di azzerare l'intero elenco, gli indici che
  // arrivano al server non corrisponderebbero più a quelli mostrati — un
  // fallimento silenzioso, non un errore. Vedi lo stesso invariante su
  // `apps/web/src/components/question-panel.tsx`.
  test("un'opzione senza etichetta azzera l'INTERO elenco: resta solo il testo libero", async () => {
    const withBadOption: Reader<InboxQuestion> = {
      ...QUESTION,
      options: [{ label: "Opzione valida" }, { label: "   " }],
    };
    await render(
      <QuestionSheet
        visible
        onRequestClose={jest.fn()}
        question={withBadOption}
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage={null}
      />,
    );
    expect(screen.queryByText("Opzione valida")).toBeNull();
    expect(screen.queryByTestId("question-sheet-option-0")).toBeNull();
    // Il testo libero resta l'unica strada.
    expect(screen.getByTestId("question-sheet-free-text")).toBeTruthy();
  });

  test("offline: il bottone d'invio è disabilitato e mostra 'Serve la rete'", async () => {
    await render(
      <QuestionSheet
        visible
        onRequestClose={jest.fn()}
        question={QUESTION}
        onSubmit={jest.fn()}
        pending={false}
        disabled
        online={false}
        errorMessage={null}
      />,
    );
    expect(screen.getAllByText("Serve la rete").length).toBeGreaterThan(0);
    expect(screen.getByTestId("question-sheet-submit").props.accessibilityState?.disabled).toBe(true);
  });

  test("mostra il messaggio d'errore quando presente", async () => {
    await render(
      <QuestionSheet
        visible
        onRequestClose={jest.fn()}
        question={QUESTION}
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage="Ci ha pensato marco@example.com."
      />,
    );
    expect(screen.getByText("Ci ha pensato marco@example.com.")).toBeTruthy();
  });

  test("toccare lo sfondo chiama onRequestClose", async () => {
    const onRequestClose = jest.fn();
    await render(
      <QuestionSheet
        visible
        onRequestClose={onRequestClose}
        question={QUESTION}
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage={null}
      />,
    );
    await fireEvent.press(screen.getByLabelText("Annulla"));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
