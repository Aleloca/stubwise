// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate, MENU_ASK_CLAUDE, MENU_PREFERENCES, MENU_SEARCH } from "./menu";
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

  it.each(["darwin", "win32", "linux"] as const)(
    "%s: «Ask Claude…» con ⌘J/Ctrl+J subito dopo «Search…», e manda il suo canale",
    (platform) => {
      const send = vi.fn();
      const template = buildMenuTemplate(platform, "Stubwise", send);
      const file = template.find((i) => i.label === "File")!;
      const items = file.submenu as MenuItemConstructorOptions[];
      const at = items.findIndex((i) => i.label === "Search…");
      const ask = items[at + 1];
      expect(ask?.label).toBe("Ask Claude…");
      expect(ask?.accelerator).toBe("CmdOrCtrl+J");
      (ask?.click as () => void)();
      expect(MENU_ASK_CLAUDE).toBe("menu:ask-claude");
      expect(send.mock.calls).toEqual([[MENU_ASK_CLAUDE]]);
    },
  );
});

// I canali IPC, letti dal sorgente: `theme:changed`, i `menu:*` e, dall'area
// 11a, il solo `file:save` (decisione 8 della spec). Un canale in più (o
// scelto dal renderer) fa fallire questo test. Il preload espone solo
// `window.stubwise` con le sue quattro voci.
describe("canali IPC", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const main = read("./index.ts");
  const preload = read("../preload/index.ts");
  const EXPECTED = ["file:save", "menu:ask-claude", "menu:preferences", "menu:search", "theme:changed"];

  /** I nomi dei canali: ogni stringa `<parola>:<parola>` che non sia un import `node:`. */
  const channelsIn = (source: string) =>
    [...source.matchAll(/["'`]([a-z]+:[a-z-]+)["'`]/g)].map((m) => m[1]!).filter((c) => !c.startsWith("node:"));

  it("main e preload nominano solo i canali attesi, file:save compreso", () => {
    const all = new Set([...channelsIn(main), ...channelsIn(preload), ...Object.values({ MENU_SEARCH, MENU_PREFERENCES, MENU_ASK_CLAUDE })]);
    expect([...all].sort()).toEqual(EXPECTED);
    expect(main).toMatch(/ipcMain\.handle\("file:save",/);
    expect(preload).toMatch(/ipcRenderer\.invoke\("file:save",/);
  });

  it("nessuna chiamata IPC con un canale che non sia letterale (tranne i menu della lista fissa)", () => {
    const calls = [...`${main}\n${preload}`.matchAll(/ipc(?:Main|Renderer)\.(on|handle|send|invoke|once)\(\s*([^,)]+)/g)];
    const dynamic = calls.map((m) => m[2]!.trim()).filter((arg) => !/^"[a-z]+:[a-z-]+"$/.test(arg));
    expect(dynamic).toEqual(["channel"]);
  });

  it("il preload espone solo platform, setTheme, onMenu e saveFile", () => {
    const exposed = preload.match(/exposeInMainWorld\("stubwise", \{([\s\S]*)\}\);/)?.[1] ?? "";
    const keys = [...exposed.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["platform", "setTheme", "onMenu", "saveFile"]);
  });
});
