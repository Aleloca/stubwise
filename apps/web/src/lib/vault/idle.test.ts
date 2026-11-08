import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleTimer, VAULT_IDLE_MS } from "./idle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startIdleTimer", () => {
  it("chiude dopo 15 minuti senza interazioni, non prima", () => {
    const onIdle = vi.fn();
    const stop = startIdleTimer(onIdle);
    expect(VAULT_IDLE_MS).toBe(15 * 60 * 1000);
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Una volta sola: dopo è fermo.
    vi.advanceTimersByTime(VAULT_IDLE_MS * 2);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ogni interazione fa ripartire il conto", () => {
    const onIdle = vi.fn();
    const stop = startIdleTimer(onIdle);
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("il solo movimento del mouse non conta come interazione", () => {
    const onIdle = vi.fn();
    const stop = startIdleTimer(onIdle);
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    window.dispatchEvent(new Event("mousemove"));
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("fermato, non scatta più e non ascolta più", () => {
    const onIdle = vi.fn();
    const stop = startIdleTimer(onIdle);
    stop();
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(VAULT_IDLE_MS * 2);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
