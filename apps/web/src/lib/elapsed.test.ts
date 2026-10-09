import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { elapsedParts, useNow } from "./elapsed";

describe("elapsedParts", () => {
  it("conta da startedAt, mai negativo", () => {
    const start = "2026-10-09T10:00:00.000Z";
    expect(elapsedParts(start, Date.parse("2026-10-09T11:05:00.000Z"))).toEqual({
      hours: 1,
      minutes: 5,
    });
    expect(elapsedParts(start, Date.parse("2026-10-09T09:00:00.000Z"))).toEqual({
      hours: 0,
      minutes: 0,
    });
  });
});

describe("useNow", () => {
  afterEach(() => vi.useRealTimers());

  it("avanza col timer", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow(1000));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(first);
  });
});
