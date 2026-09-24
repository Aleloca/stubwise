import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { GhostButton } from "./GhostButton";
import { PRIMARY_BUTTON_HEIGHT } from "./PrimaryButton";

function heightOf(testID: string): unknown {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.height;
}

/**
 * L'altezza del bottone secondario (24 set 2026). Da solo resta 44 — scelta
 * del maintainer —, accanto a un `PrimaryButton` prende la SUA altezza:
 * affiancati non combaciavano («Add to backlog» più alto di «Cancel»).
 */
describe("GhostButton — altezza", () => {
  test("da solo resta 44", async () => {
    await render(<GhostButton label="Retry" onPress={jest.fn()} testID="ghost" />);
    expect(heightOf("ghost")).toBe(44);
  });

  test("accanto al principale prende la sua altezza", async () => {
    await render(<GhostButton label="Cancel" onPress={jest.fn()} besidePrimary testID="ghost" />);
    expect(heightOf("ghost")).toBe(PRIMARY_BUTTON_HEIGHT);
  });
});
