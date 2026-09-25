import { act, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Text } from "react-native";
import { WISEY_CYCLE_MS, type WiseyPhase } from "../lib/wisey-phase";
import { useWiseyTabIcon, WISEY_TAB_FRAMES, WISEY_TAB_MIN_FRAME_MS } from "./wisey-tab-icon";

/**
 * L'ICONA DELLA TAB SI ANIMA sulla fase del gufo grande (design §10): la
 * barra nativa non anima immagini, quindi l'hook restituisce un'icona diversa
 * a ogni fotogramma, e la barra la riceve a ogni cambio.
 */
/** OGNI icona resa, in ordine: ogni render qui è un'icona spedita alla barra nativa. */
let rendered: string[] = [];

function Probe({ phase }: { phase: WiseyPhase }) {
  const icon = useWiseyTabIcon(phase);
  const [name, frame] = Object.entries(WISEY_TAB_FRAMES).flatMap(([p, frames]) =>
    frames.map((source, index) => (source === icon ? [p, index] : null)).filter(Boolean),
  )[0] as [string, number];
  rendered.push(`${name}:${frame}`);
  return <Text testID="probe">{`${name}:${frame}`}</Text>;
}

const shown = () => screen.getByTestId("probe").props.children as string;

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  rendered = [];
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useWiseyTabIcon", () => {
  test("parte dal primo fotogramma e avanza di uno ogni quarto di ciclo", async () => {
    await render(<Probe phase="rest" />);
    await advance(0);
    expect(shown()).toBe("rest:0");
    await advance(WISEY_CYCLE_MS.rest / 4);
    expect(shown()).toBe("rest:1");
    await advance((WISEY_CYCLE_MS.rest / 4) * 3);
    expect(shown()).toBe("rest:0");
  });

  test("segue la fase: cambiandola si passa al primo fotogramma della nuova", async () => {
    const view = await render(<Probe phase="rest" />);
    await advance((WISEY_CYCLE_MS.rest / 4) * 2);
    expect(shown()).toBe("rest:2");
    rendered = [];
    await view.rerender(<Probe phase="speak" />);
    expect(shown()).toBe("speak:0");
    // Nemmeno per un render la fase nuova col fotogramma rimasto dalla vecchia.
    expect(rendered.filter((icon) => icon !== "speak:0")).toEqual([]);
    await advance(WISEY_CYCLE_MS.speak / 4);
    expect(shown()).toBe("speak:1");
  });

  test("il passo minimo è UNA costante, oggi 120 ms: «ti risponde» va al vero ritmo", async () => {
    expect(WISEY_TAB_MIN_FRAME_MS).toBe(120);
    await render(<Probe phase="speak" />);
    await advance(120);
    expect(shown()).toBe("speak:1");
  });

  test("con la riduzione del movimento resta sul primo fotogramma della fase", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const view = await render(<Probe phase="rest" />);
    // NON un multiplo del ciclo (4 passi = un giro esatto, tornerebbe a 0).
    await advance((WISEY_CYCLE_MS.rest / 4) * 5);
    expect(shown()).toBe("rest:0");
    await view.rerender(<Probe phase="think" />);
    await advance((WISEY_CYCLE_MS.think / 4) * 5);
    expect(shown()).toBe("think:0");
  });
});
