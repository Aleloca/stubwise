import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { SheetModal } from "./SheetModal";

/**
 * `SheetModal` col foglio nativo SOSTITUITO dal mock globale di
 * `@lodev09/react-native-true-sheet` (`jest.setup.ts`): rende i figli finché
 * è presentato, e ha un bottone `true-sheet-dismiss` che fa quello che farebbe
 * il dito trascinando in giù — solo se `dismissible` non è `false`, come il
 * sistema.
 */
describe("SheetModal", () => {
  test("aperto: il contenuto c'è, col suo testID", async () => {
    await render(
      <SheetModal open onClose={jest.fn()} testID="pannello">
        <Text>contenuto</Text>
      </SheetModal>,
    );
    expect(screen.getByText("contenuto")).toBeTruthy();
    expect(screen.getByTestId("pannello")).toBeTruthy();
  });

  test("chiuso: niente contenuto", async () => {
    await render(
      <SheetModal open={false} onClose={jest.fn()}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    expect(screen.queryByText("contenuto")).toBeNull();
  });

  test("segue la prop: aperto, poi chiuso, poi di nuovo aperto", async () => {
    const onClose = jest.fn();
    const view = await render(
      <SheetModal open onClose={onClose}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    await view.rerender(
      <SheetModal open={false} onClose={onClose}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    expect(screen.queryByText("contenuto")).toBeNull();
    await view.rerender(
      <SheetModal open onClose={onClose}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    expect(screen.getByText("contenuto")).toBeTruthy();
  });

  test("trascinato via: si chiude e lo dice con onClose", async () => {
    const onClose = jest.fn();
    await render(
      <SheetModal open onClose={onClose}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("contenuto")).toBeNull();
  });

  /**
   * ⚠️ Un pannello NON chiudibile — un'operazione in corso che non si
   * interrompe a metà — resta aperto anche se lo si trascina, e `onClose`
   * non arriva. Diventa rosso togliendo `dismissible` dal foglio.
   */
  test("non chiudibile: trascinarlo non lo chiude e onClose non arriva", async () => {
    const onClose = jest.fn();
    await render(
      <SheetModal open onClose={onClose} dismissible={false}>
        <Text>contenuto</Text>
      </SheetModal>,
    );
    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("contenuto")).toBeTruthy();
  });

  test("le tre forme rendono il contenuto: che scorre, fisso, pagina", async () => {
    for (const props of [{}, { scrollable: false }, { fullHeight: true }]) {
      const view = await render(
        <SheetModal open onClose={jest.fn()} testID="forma" {...props}>
          <Text>dentro</Text>
        </SheetModal>,
      );
      expect(screen.getByTestId("forma")).toBeTruthy();
      expect(screen.getByText("dentro")).toBeTruthy();
      await view.unmount();
    }
  });
});
