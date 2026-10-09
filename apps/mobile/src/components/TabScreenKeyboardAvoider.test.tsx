import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { BottomTabBarHeightContext } from "react-native-bottom-tabs";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { TabScreenKeyboardAvoider, tabScreenKeyboardOffset } from "./TabScreenKeyboardAvoider";

/**
 * `jest.setup.ts` mocka `useBottomTabBarHeight` → 0 per tutta la suite, quindi
 * lì l'originale non lancerebbe mai. Qui torna quello VERO: è l'unico modo di
 * provare che il componente, fuori da una scena delle schede, non lancia.
 */
jest.mock("react-native-bottom-tabs", () => ({
  __esModule: true,
  ...jest.requireActual("react-native-bottom-tabs"),
  useBottomTabBarHeight: jest.requireActual("react-native-bottom-tabs").useBottomTabBarHeight,
}));

const INSETS = { top: 0, left: 0, right: 0, bottom: 34 };

/**
 * Lo scostamento delle schermate col campo in fondo (25 set 2026). La barra
 * delle schede finisce DIETRO la tastiera: se la schermata si alzasse di
 * tutta la tastiera, sopra resterebbe un vuoto alto quanto la barra — il
 * campo porta già quell'altezza nel suo `paddingBottom`.
 */
describe("tabScreenKeyboardOffset", () => {
  test("toglie l'altezza della barra delle schede, non la aggiunge", () => {
    expect(tabScreenKeyboardOffset(83)).toBe(-83);
  });
});

describe("TabScreenKeyboardAvoider", () => {
  test("dentro una scena delle schede si rende", async () => {
    await render(
      <SafeAreaInsetsContext.Provider value={INSETS}>
        <BottomTabBarHeightContext.Provider value={83}>
          <TabScreenKeyboardAvoider>
            <Text>campo</Text>
          </TabScreenKeyboardAvoider>
        </BottomTabBarHeightContext.Provider>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(screen.getByText("campo")).toBeTruthy();
  });

  test("fuori dalle schede (la sessione aperta da una push) non lancia: ripiega sull'inset in basso", async () => {
    await render(
      <SafeAreaInsetsContext.Provider value={INSETS}>
        <TabScreenKeyboardAvoider>
          <Text>campo</Text>
        </TabScreenKeyboardAvoider>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(screen.getByText("campo")).toBeTruthy();
    // L'altezza usata (la barra o, fuori, l'inset) è quella di
    // `useBottomTabBarHeightSafe`, provata in `lib/tab-bar-height-safe.test.tsx`:
    // le prop di `KeyboardAvoidingView` non arrivano alla View ospite.
  });
});
