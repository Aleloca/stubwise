import { NavigationContext } from "@react-navigation/native";
import { act, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { WiseySprite } from "./WiseySprite";

/**
 * Lo sprite del gufo («Wisey, anteprima nell'app» §7): quattro fotogrammi
 * affiancati in un PNG, un timer a quattro passi che sposta l'immagine dentro
 * un contenitore che la ritaglia. Niente librerie d'animazione, niente
 * interpolazione fra fotogrammi.
 */
type Listener = () => void;

/**
 * Lo sprite è nascosto all'accessibilità apposta (lo stato lo dice il testo
 * accanto), e RNTL esclude gli elementi nascosti dalle query di default.
 */
const HIDDEN = { includeHiddenElements: true };

/** Un navigatore finto quanto basta: a fuoco o no, e i due eventi. */
function fakeNavigation(initiallyFocused: boolean) {
  let focused = initiallyFocused;
  const listeners: Record<string, Listener[]> = { focus: [], blur: [] };
  return {
    isFocused: () => focused,
    addListener: (event: "focus" | "blur", listener: Listener) => {
      listeners[event]!.push(listener);
      return () => {
        listeners[event] = listeners[event]!.filter((l) => l !== listener);
      };
    },
    set(next: boolean) {
      focused = next;
      for (const listener of listeners[next ? "focus" : "blur"]!) listener();
    },
  };
}

/** Il fotogramma mostrato: lo spostamento dell'immagine diviso la larghezza di uno. */
function frame(width: number): number {
  const style = StyleSheet.flatten(screen.getByTestId("wisey-sprite-image", HIDDEN).props.style) as { marginLeft?: number };
  return -(style.marginLeft ?? 0) / width;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("WiseySprite", () => {
  test("il fotogramma avanza di uno ogni quarto di ciclo, e ricomincia dopo il quarto", async () => {
    // «ti risponde»: ciclo 480 ms, quindi un passo ogni 120 ms.
    await render(<WiseySprite phase="speak" size="small" />);
    await flush();
    expect(frame(56)).toBe(0);
    await act(async () => jest.advanceTimersByTime(120));
    expect(frame(56)).toBe(1);
    await act(async () => jest.advanceTimersByTime(240));
    expect(frame(56)).toBe(3);
    await act(async () => jest.advanceTimersByTime(120));
    expect(frame(56)).toBe(0);
  });

  test("il gufo grande è a 2×: fotogrammi da 112×96", async () => {
    await render(<WiseySprite phase="speak" size="large" />);
    await flush();
    const box = StyleSheet.flatten(screen.getByTestId("wisey-sprite", HIDDEN).props.style) as { width: number; height: number };
    expect([box.width, box.height]).toEqual([112, 96]);
    await act(async () => jest.advanceTimersByTime(120));
    expect(frame(112)).toBe(1);
  });

  test("ogni fase ha il suo sprite", async () => {
    const view = await render(<WiseySprite phase="rest" size="small" />);
    for (const [phase, file] of [
      ["rest", "gufo-riposo"],
      ["listen", "gufo-ascolta"],
      ["think", "gufo-pensa"],
      ["work", "gufo-lavora"],
      ["speak", "gufo-parla"],
      ["done", "gufo-fatto"],
    ] as const) {
      await view.rerender(<WiseySprite phase={phase} size="small" />);
      expect(JSON.stringify(screen.getByTestId("wisey-sprite-image", HIDDEN).props.source)).toContain(file);
    }
    await view.rerender(<WiseySprite phase="rest" size="large" />);
    expect(JSON.stringify(screen.getByTestId("wisey-sprite-image", HIDDEN).props.source)).toContain("gufo-riposo-large");
  });

  test("cambiando fase si riparte dal primo fotogramma", async () => {
    const view = await render(<WiseySprite phase="speak" size="small" />);
    await flush();
    await act(async () => jest.advanceTimersByTime(240));
    expect(frame(56)).toBe(2);
    await view.rerender(<WiseySprite phase="think" size="small" />);
    expect(frame(56)).toBe(0);
  });

  describe("fermo al primo fotogramma", () => {
    /**
     * ⚠️ NON un multiplo del ciclo: con 1000 ms (otto passi da 120, due giri
     * esatti) un gufo che si muove torna al fotogramma 0 e il test passerebbe
     * lo stesso. 600 ms sono cinque passi: se girasse, sarebbe al fotogramma 1.
     */
    const STILL_CHECK_MS = 600;

    test("quando `animated` è falso (il gufo piccolo accanto ai messaggi)", async () => {
      await render(<WiseySprite phase="speak" size="small" animated={false} />);
      await flush();
      await act(async () => jest.advanceTimersByTime(STILL_CHECK_MS));
      expect(frame(56)).toBe(0);
    });

    test("con la riduzione del movimento di sistema attiva", async () => {
      jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
      await render(<WiseySprite phase="speak" size="small" />);
      await flush();
      await act(async () => jest.advanceTimersByTime(STILL_CHECK_MS));
      expect(frame(56)).toBe(0);
    });

    test("quando la tab non è a fuoco, e riparte quando lo torna", async () => {
      const navigation = fakeNavigation(false);
      await render(
        <NavigationContext.Provider value={navigation as never}>
          <WiseySprite phase="speak" size="small" />
        </NavigationContext.Provider>,
      );
      await flush();
      await act(async () => jest.advanceTimersByTime(STILL_CHECK_MS));
      expect(frame(56)).toBe(0);

      await act(async () => navigation.set(true));
      await act(async () => jest.advanceTimersByTime(120));
      expect(frame(56)).toBe(1);

      await act(async () => navigation.set(false));
      expect(frame(56)).toBe(0);
      await act(async () => jest.advanceTimersByTime(STILL_CHECK_MS));
      expect(frame(56)).toBe(0);
    });
  });
});
