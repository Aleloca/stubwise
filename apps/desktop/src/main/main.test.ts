// @vitest-environment node
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate, MENU_PREFERENCES, MENU_SEARCH } from "./menu";
import { groundFor, isResolvedTheme, overlayFor, themeFromDark, windowOptions } from "./window";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
}

describe("opzioni di finestra", () => {
  it("macOS: barra nascosta con i semafori sul binario e sfondo del tema", () => {
    const o = windowOptions("darwin", "dark");
    expect(o).toMatchObject({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 6, y: 12 },
      backgroundColor: "#121314",
    });
    expect("titleBarOverlay" in o).toBe(false);
  });

  it("Windows: overlay coi colori del tema", () => {
    expect(windowOptions("win32", "light")).toMatchObject({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: groundFor("light"), symbolColor: "#151618", height: 32 },
      backgroundColor: groundFor("light"),
    });
    expect(overlayFor("dark").color).toBe("#121314");
  });

  it("Linux: solo lo sfondo", () => {
    expect(windowOptions("linux", "dark")).toEqual({ backgroundColor: "#121314" });
  });

  it("tema dal sistema e validazione del valore IPC", () => {
    expect(themeFromDark(true)).toBe("dark");
    expect(themeFromDark(false)).toBe("light");
    expect(isResolvedTheme("dark")).toBe(true);
    expect(isResolvedTheme("blue")).toBe(false);
    expect(isResolvedTheme(undefined)).toBe(false);
  });
});

describe("menu dell'applicazione", () => {
  const labels = (t: MenuItemConstructorOptions[]) => t.map((i) => i.label);

  it("macOS: App/File/Edit/View/Window/Help", () => {
    expect(labels(buildMenuTemplate("darwin", "Stubwise", vi.fn()))).toEqual([
      "Stubwise",
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
  });

  it("Windows: File/Edit/View/Help", () => {
    expect(labels(buildMenuTemplate("win32", "Stubwise", vi.fn()))).toEqual([
      "File",
      "Edit",
      "View",
      "Help",
    ]);
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "%s: Search… e Preferences… hanno l'acceleratore e mandano il canale IPC",
    (platform) => {
      const send = vi.fn();
      const items = flatten(buildMenuTemplate(platform, "Stubwise", send));
      const search = items.find((i) => i.label === "Search…");
      const prefs = items.find((i) => i.label === "Preferences…");
      expect(search?.accelerator).toBe("CmdOrCtrl+K");
      expect(prefs?.accelerator).toBe("CmdOrCtrl+,");
      (search?.click as () => void)();
      (prefs?.click as () => void)();
      expect(send.mock.calls).toEqual([[MENU_SEARCH], [MENU_PREFERENCES]]);
    },
  );
});
