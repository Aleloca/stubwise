import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMatchMedia } from "../test/setup";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import { THEME_STORAGE_KEY } from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

let api: ReturnType<typeof useTheme> | null = null;

function Probe() {
  api = useTheme();
  return (
    <span data-testid="probe">
      {api.preference}/{api.resolved}
    </span>
  );
}

function mount() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  api = null;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThemeProvider e il main", () => {
  afterEach(() => {
    delete window.stubwise;
  });

  it("comunica il tema risolto a window.stubwise.setTheme, e di nuovo quando cambia", () => {
    const setTheme = vi.fn();
    window.stubwise = { platform: "darwin", setTheme };
    setMatchMedia(DARK_QUERY, true);
    mount();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    act(() => api?.setPreference("light"));
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(setTheme).toHaveBeenCalledTimes(2);
  });

  it("senza preload (browser) non fa nulla e non lancia", () => {
    expect(window.stubwise).toBeUndefined();
    expect(() => mount()).not.toThrow();
  });

  it("con un preload senza setTheme non lancia", () => {
    window.stubwise = { platform: "darwin" };
    expect(() => mount()).not.toThrow();
  });
});

describe("ThemeProvider", () => {
  it("con preferenza di sistema segue il sistema, anche quando cambia", () => {
    setMatchMedia(DARK_QUERY, true);
    mount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("probe")).toHaveTextContent("system/dark");

    act(() => setMatchMedia(DARK_QUERY, false));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByTestId("probe")).toHaveTextContent("system/light");
  });

  it("una preferenza esplicita ignora i cambi di sistema", () => {
    setMatchMedia(DARK_QUERY, false);
    mount();
    act(() => api!.setPreference("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => setMatchMedia(DARK_QUERY, false));
    act(() => setMatchMedia(DARK_QUERY, true));
    act(() => setMatchMedia(DARK_QUERY, false));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("probe")).toHaveTextContent("dark/dark");
  });

  it("la preferenza sopravvive a un rimontaggio", () => {
    setMatchMedia(DARK_QUERY, true);
    const first = mount();
    act(() => api!.setPreference("light"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    first.unmount();

    mount();
    expect(api!.preference).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("un valore sconosciuto in localStorage vale come sistema", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    setMatchMedia(DARK_QUERY, true);
    mount();
    expect(api!.preference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("un localStorage che lancia non rompe nulla: si usa il sistema", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setMatchMedia(DARK_QUERY, true);
    mount();
    expect(api!.preference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => api!.setPreference("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("useTheme fuori dal provider lancia un errore esplicito", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});
