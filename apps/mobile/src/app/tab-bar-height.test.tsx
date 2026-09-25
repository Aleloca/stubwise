import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { TabBarHeightProvider, TabBarHeightReporter, useTabBarHeight } from "./tab-bar-height";

/**
 * L'ALTEZZA DELLA BARRA, portata FUORI dalle scene (design §11): la libreria
 * la dà solo a chi sta dentro una schermata, e il cerchio sta sopra le schede.
 */
function Reader() {
  return <Text testID="height">{String(useTabBarHeight())}</Text>;
}

describe("TabBarHeightReporter", () => {
  test("prima di ogni misura vale 0", async () => {
    await render(
      <TabBarHeightProvider>
        <Reader />
      </TabBarHeightProvider>,
    );
    expect(screen.getByTestId("height").props.children).toBe("0");
  });

  test("il riportatore, dentro una scena, scrive la misura vera per chi sta fuori", async () => {
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(83);
    await render(
      <TabBarHeightProvider>
        <TabBarHeightReporter />
        <Reader />
      </TabBarHeightProvider>,
    );
    expect(screen.getByTestId("height").props.children).toBe("83");
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(0);
  });
});
