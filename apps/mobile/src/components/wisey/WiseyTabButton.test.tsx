import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet } from "react-native";
import "../../i18n";
import { TabBarHeightContext } from "../../app/tab-bar-height";
import { useWisey, WiseyProvider, type WiseyStore } from "./WiseyProvider";
import { WISEY_BUTTON_OFFSET_PT, WISEY_BUTTON_OUTER_PT, WiseyTabButton } from "./WiseyTabButton";

/**
 * IL CERCHIO CHE SPORGE sopra la barra (design §11): il nostro bottone,
 * centrato sulla terza tab, col gufo animato sulla fase dello store.
 */
const HIDDEN = { includeHiddenElements: true };
let store: WiseyStore;

function Probe() {
  store = useWisey();
  return null;
}

async function mount(tabBarHeight: number, onPress = jest.fn()) {
  await render(
    <TabBarHeightContext.Provider value={{ height: tabBarHeight, setHeight: () => {} }}>
      <WiseyProvider>
        <Probe />
        <WiseyTabButton onPress={onPress} />
      </WiseyProvider>
    </TabBarHeightContext.Provider>,
  );
  return onPress;
}

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

describe("WiseyTabButton", () => {
  test("finché la barra non è misurata (0) non compare: meglio niente che un cerchio fuori posto", async () => {
    await mount(0);
    expect(screen.queryByTestId("wisey-tab-button")).toBeNull();
  });

  test("con la misura compare, e il suo centro sta sul bordo superiore della barra", async () => {
    await mount(83);
    const style = StyleSheet.flatten(screen.getByTestId("wisey-tab-button-anchor").props.style) as { bottom: number };
    expect(style.bottom).toBe(83 - WISEY_BUTTON_OUTER_PT / 2 + WISEY_BUTTON_OFFSET_PT);
  });

  test("segue un'altra misura: si aggancia alla barra, non a un numero scritto a mano", async () => {
    await mount(49);
    const style = StyleSheet.flatten(screen.getByTestId("wisey-tab-button-anchor").props.style) as { bottom: number };
    expect(style.bottom).toBe(49 - WISEY_BUTTON_OUTER_PT / 2 + WISEY_BUTTON_OFFSET_PT);
  });

  test("dentro c'è il gufo del cerchio, sulla fase dello store", async () => {
    await mount(83);
    expect(JSON.stringify(screen.getByTestId("wisey-sprite-image", HIDDEN).props.source)).toContain("gufo-riposo-button");
    await act(async () => store.setDraft("ciao"));
    expect(JSON.stringify(screen.getByTestId("wisey-sprite-image", HIDDEN).props.source)).toContain("gufo-ascolta-button");
  });

  test("è un bottone che si chiama «Wisey», e il tap porta alla sua tab", async () => {
    const onPress = await mount(83);
    const button = screen.getByRole("button", { name: "Wisey" });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("a tab Wisey a fuoco il bordo ambra si accende di più", async () => {
    await mount(83);
    const ring = () => StyleSheet.flatten(screen.getByTestId("wisey-tab-button").props.style) as { borderWidth: number };
    const off = ring().borderWidth;
    await act(async () => store.setTabFocused(true));
    expect(ring().borderWidth).toBeGreaterThan(off);
    expect(screen.getByTestId("wisey-tab-button").props.accessibilityState).toMatchObject({ selected: true });
  });
});
