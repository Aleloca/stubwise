import { fireEvent, render, screen } from "@testing-library/react-native";
import "../../i18n";
import { SnoozeSheet } from "./SnoozeSheet";

describe("SnoozeSheet", () => {
  test("nascosto quando visible=false", async () => {
    await render(<SnoozeSheet visible={false} onRequestClose={jest.fn()} onChoose={jest.fn()} />);
    expect(screen.queryByText("1h")).toBeNull();
  });

  test("mostra le tre etichette del canvas: 1h / Stasera / Domani", async () => {
    await render(<SnoozeSheet visible onRequestClose={jest.fn()} onChoose={jest.fn()} />);
    expect(screen.getByText("1h")).toBeTruthy();
    expect(screen.getByText("Stasera")).toBeTruthy();
    expect(screen.getByText("Domani")).toBeTruthy();
  });

  // Il test cerca per TESTO (l'etichetta del canvas), non per testID derivato
  // dal valore: uno scambio accidentale dei due `i18nKey` nell'array
  // (`SNOOZE_OPTIONS`) — "Stasera" che invia `3d`, "Domani" che invia
  // `tomorrow` — farebbe fallire QUESTO test, mentre un test per testID
  // (`snooze-sheet-tomorrow`) non se ne accorgerebbe mai.
  test("'1h' chiama onChoose con il valore '1h'", async () => {
    const onChoose = jest.fn();
    await render(<SnoozeSheet visible onRequestClose={jest.fn()} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText("1h"));
    expect(onChoose).toHaveBeenCalledWith("1h");
  });

  test("'Stasera' chiama onChoose con il valore API 'tomorrow' (mappatura label→value del canvas)", async () => {
    const onChoose = jest.fn();
    await render(<SnoozeSheet visible onRequestClose={jest.fn()} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText("Stasera"));
    expect(onChoose).toHaveBeenCalledWith("tomorrow");
  });

  test("'Domani' chiama onChoose con il valore API '3d' (mappatura label→value del canvas)", async () => {
    const onChoose = jest.fn();
    await render(<SnoozeSheet visible onRequestClose={jest.fn()} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText("Domani"));
    expect(onChoose).toHaveBeenCalledWith("3d");
  });

  test("disabled: nessuna opzione chiama onChoose", async () => {
    const onChoose = jest.fn();
    await render(<SnoozeSheet visible onRequestClose={jest.fn()} onChoose={onChoose} disabled />);
    await fireEvent.press(screen.getByText("1h"));
    expect(onChoose).not.toHaveBeenCalled();
  });

  test("toccare lo sfondo chiama onRequestClose", async () => {
    const onRequestClose = jest.fn();
    await render(<SnoozeSheet visible onRequestClose={onRequestClose} onChoose={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText("Annulla"));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
