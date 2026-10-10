import { BlurView } from "@react-native-community/blur";
import { render, screen } from "@testing-library/react-native";
import { Platform, StyleSheet, Text } from "react-native";
import { colors } from "../theme/tokens";
import { GLASS_ANDROID_BACKGROUND, GLASS_BLUR_TYPE, GLASS_BORDER_COLOR, Glass } from "./Glass";

/**
 * Il fondo «di vetro» (9 ott 2026, Task A3): composer, «↓» e barre senza
 * scrittura stanno SOPRA la trascrizione, che ci scorre dietro. Su iOS il
 * fondo è un `BlurView` nativo; su Android niente blur, ink900 all'~85%.
 */
describe("Glass", () => {
  test("il mock del blur: un componente host che porta le sue prop", async () => {
    await render(<BlurView blurType="dark" reducedTransparencyFallbackColor="#000000" testID="blur" />);
    const blur = screen.getByTestId("blur");
    expect(blur.props.blurType).toBe("dark");
    expect(blur.props.reducedTransparencyFallbackColor).toBe("#000000");
  });

  describe("iOS", () => {
    test("un BlurView scuro DIETRO il contenuto, a tutta superficie, col ripiego ink900", async () => {
      await render(
        <Glass style={{ borderRadius: 22 }} testID="glass">
          <Text>contenuto</Text>
        </Glass>,
      );
      const glass = screen.getByTestId("glass");
      const blur = screen.getByTestId("glass-blur");
      expect(blur.props.blurType).toBe(GLASS_BLUR_TYPE);
      expect(blur.props.reducedTransparencyFallbackColor).toBe(colors.ink900);
      expect(StyleSheet.flatten(blur.props.style)).toMatchObject({ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 });
      // Il blur non prende i tocchi, e sta PRIMA del contenuto (dietro).
      expect(blur.props.pointerEvents).toBe("none");
      const children = glass.children as { props: { testID?: string } }[];
      expect(children[0]?.props.testID).toBe("glass-blur");
      expect(screen.getByText("contenuto")).toBeTruthy();
      const style = StyleSheet.flatten(glass.props.style);
      // Niente fondo pieno: si vedrebbe quello, non il vetro.
      expect(style.backgroundColor).toBeUndefined();
      expect(style.borderColor).toBe(GLASS_BORDER_COLOR);
      expect(style.borderWidth).toBe(StyleSheet.hairlineWidth);
      expect(style.overflow).toBe("hidden");
      expect(style.borderRadius).toBe(22);
    });

    test("il bordo è lineStrong semitrasparente", () => {
      expect(GLASS_BORDER_COLOR.toLowerCase().startsWith(colors.lineStrong.toLowerCase())).toBe(true);
      expect(GLASS_BORDER_COLOR).toHaveLength(9);
    });

    test("il blurType è uno scuro", () => {
      expect(GLASS_BLUR_TYPE.toLowerCase()).toContain("dark");
    });
  });

  describe("Android", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "android");
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("niente blur nativo: fondo ink900 all'~85%", async () => {
      await render(
        <Glass testID="glass">
          <Text>contenuto</Text>
        </Glass>,
      );
      expect(screen.queryByTestId("glass-blur")).toBeNull();
      const style = StyleSheet.flatten(screen.getByTestId("glass").props.style);
      expect(style.backgroundColor).toBe(GLASS_ANDROID_BACKGROUND);
      expect(style.borderColor).toBe(GLASS_BORDER_COLOR);
      expect(screen.getByText("contenuto")).toBeTruthy();
    });

    test("il fondo Android è ink900 con alfa ~85% (0xD9)", () => {
      expect(GLASS_ANDROID_BACKGROUND.toLowerCase()).toBe(`${colors.ink900.toLowerCase()}d9`);
    });
  });
});
