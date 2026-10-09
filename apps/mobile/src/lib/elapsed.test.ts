import { act, renderHook } from "@testing-library/react-native";
import { elapsedParts } from "@stubwise/shared";
import { useNow } from "./elapsed";

describe("elapsedParts (da @stubwise/shared)", () => {
  const start = "2026-10-09T10:00:00.000Z";
  const at = (ms: number) => Date.parse(start) + ms;

  test("ore e minuti", () => {
    expect(elapsedParts(start, at(2 * 3_600_000 + 5 * 60_000))).toEqual({ hours: 2, minutes: 5 });
  });
  test("meno di un minuto", () => {
    expect(elapsedParts(start, at(30_000))).toEqual({ hours: 0, minutes: 0 });
  });
  test("un orologio indietro non va sotto zero", () => {
    expect(elapsedParts(start, at(-60_000))).toEqual({ hours: 0, minutes: 0 });
  });
});

describe("useNow", () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  test("si rinnova a ogni intervallo", async () => {
    const { result } = await renderHook(() => useNow(1_000));
    expect(result.current).toBe(1_000_000);
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1_001_000);
  });

  test("smontato, smette di rinnovarsi", async () => {
    const { result, unmount } = await renderHook(() => useNow(1_000));
    await unmount();
    jest.advanceTimersByTime(5_000);
    expect(result.current).toBe(1_000_000);
  });
});
