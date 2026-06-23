import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setMatchMedia } from "../test/setup";
import { useMediaQuery } from "./use-media-query";

/**
 * useMediaQuery: legge lo stato iniziale di `matchMedia` e resta reattivo ai
 * cambi di viewport (evento `change` della MediaQueryList). Il mock di
 * `matchMedia` (test/setup) è pilotabile con `setMatchMedia`.
 */
describe("useMediaQuery", () => {
  const QUERY = "(min-width: 768px)";

  it("riflette lo stato iniziale della query", () => {
    setMatchMedia(QUERY, true);
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(true);
  });

  it("di default (viewport mobile) la query desktop non matcha", () => {
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
  });

  it("aggiorna il valore quando il viewport cambia", () => {
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);

    act(() => setMatchMedia(QUERY, true));
    expect(result.current).toBe(true);

    act(() => setMatchMedia(QUERY, false));
    expect(result.current).toBe(false);
  });
});
