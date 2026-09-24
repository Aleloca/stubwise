import { fireEvent, render, screen } from "@testing-library/react-native";
import "../../i18n";
import { RejectSheet } from "./RejectSheet";

async function renderSheet(overrides: Partial<React.ComponentProps<typeof RejectSheet>> = {}) {
  const onSubmit = jest.fn<void, [string | undefined]>();
  const onRequestClose = jest.fn();
  await render(
    <RejectSheet
      visible
      onRequestClose={onRequestClose}
      contextLine="Piano: cache delle immagini prodotto — Portale B2B"
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

describe("RejectSheet", () => {
  /**
   * ⚠️ Il pannello è il FOGLIO NATIVO (24 set 2026): la tastiera la gestisce
   * lui (`TrueSheetKeyboardObserver` fa crescere il pannello e dà l'inset
   * allo scroll), quindi non sta più dentro `SheetBackdrop`, che disegnava
   * anche il velo opaco segnalato dal maintainer. Il layout vero non si
   * misura qui; il test tiene il CABLAGGIO — chi rimettesse `SheetBackdrop`
   * attorno al pannello lo farebbe diventare rosso. La prova che la tastiera
   * non copra il campo è sul telefono (design §6).
   */
  test("sta nel foglio nativo, non dentro lo sfondo disegnato a mano", async () => {
    await renderSheet();
    expect(screen.getByTestId("true-sheet")).toBeTruthy();
    expect(screen.queryByTestId("sheet-backdrop")).toBeNull();
  });

  test("nascosto quando visible=false", async () => {
    await render(
      <RejectSheet
        visible={false}
        onRequestClose={jest.fn()}
        contextLine="Piano: x"
        onSubmit={jest.fn()}
        pending={false}
        disabled={false}
        online
        errorMessage={null}
      />,
    );
    expect(screen.queryByText("Cosa deve cambiare?")).toBeNull();
  });

  test("mostra titolo, riga di contesto e le tre chip del canvas", async () => {
    await renderSheet();
    expect(screen.getByText("Cosa deve cambiare?")).toBeTruthy();
    expect(screen.getByText("Piano: cache delle immagini prodotto — Portale B2B")).toBeTruthy();
    expect(screen.getByText("Riduci lo scope")).toBeTruthy();
    expect(screen.getByText("Costa troppo")).toBeTruthy();
    expect(screen.getByText("Rimanda a dopo")).toBeTruthy();
  });

  test("toccare due chip e scrivere testo libero: l'invio manda le istruzioni CONCATENATE", async () => {
    const { onSubmit } = await renderSheet();
    await fireEvent.press(screen.getByTestId("reject-sheet-chip-scope"));
    await fireEvent.press(screen.getByTestId("reject-sheet-chip-cost"));
    await fireEvent.changeText(screen.getByTestId("reject-sheet-input"), "Riduci lo scope; Costa troppo; niente CDN nuove");
    await fireEvent.press(screen.getByTestId("reject-sheet-submit"));
    expect(onSubmit).toHaveBeenCalledWith("Riduci lo scope; Costa troppo; niente CDN nuove");
  });

  test("una chip da sola popola il campo con la sua frase", async () => {
    const { onSubmit } = await renderSheet();
    await fireEvent.press(screen.getByTestId("reject-sheet-chip-later"));
    expect(screen.getByTestId("reject-sheet-input").props.value).toBe("Rimanda a dopo");
    await fireEvent.press(screen.getByTestId("reject-sheet-submit"));
    expect(onSubmit).toHaveBeenCalledWith("Rimanda a dopo");
  });

  test("invio senza testo manda `undefined` (rifiuto legittimo senza istruzioni)", async () => {
    const { onSubmit } = await renderSheet();
    await fireEvent.press(screen.getByTestId("reject-sheet-submit"));
    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });

  test("'Annulla' chiama onRequestClose", async () => {
    const { onRequestClose } = await renderSheet();
    await fireEvent.press(screen.getByTestId("reject-sheet-cancel"));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  test("offline: submit disabilitato e mostra 'Serve la rete'", async () => {
    await renderSheet({ disabled: true, online: false });
    expect(screen.getAllByText("Serve la rete").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reject-sheet-submit").props.accessibilityState?.disabled).toBe(true);
  });

  test("mostra il messaggio d'errore quando presente", async () => {
    await renderSheet({ errorMessage: "Il piano non è più in attesa di approvazione." });
    expect(screen.getByText("Il piano non è più in attesa di approvazione.")).toBeTruthy();
  });
});
