import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { SheetBackdrop, sheetKeyboardBehavior } from "./SheetBackdrop";

/**
 * Lo sfondo delle finestre ancorate in basso con un campo di testo (24 set
 * 2026). Il layout vero della tastiera non si misura in Jest: qui si fissa
 * ciò che lo produce — su iOS il `behavior` è `padding` — e il tocco fuori
 * che chiude, che ogni finestra aveva scritto a mano per conto suo.
 */
describe("SheetBackdrop", () => {
  test("su iOS si solleva sopra la tastiera, su Android no", () => {
    // Su Android la finestra si ridimensiona da sola (`windowSoftInputMode`):
    // `padding` la spingerebbe su due volte.
    expect(sheetKeyboardBehavior("ios")).toBe("padding");
    expect(sheetKeyboardBehavior("android")).toBeUndefined();
  });

  test("il tocco fuori dalla finestra chiude, e il contenuto c'è", async () => {
    const onDismiss = jest.fn();
    await render(
      <SheetBackdrop onDismiss={onDismiss} dismissLabel="Chiudi">
        <Text>contenuto</Text>
      </SheetBackdrop>,
    );
    expect(screen.getByText("contenuto")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Chiudi"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
