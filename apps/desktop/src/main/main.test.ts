// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate, MENU_ASK_CLAUDE, MENU_PREFERENCES, MENU_REDO, MENU_SEARCH, MENU_UNDO } from "./menu";
import { groundFor, isResolvedTheme, overlayFor, PAPER, printOnPaper, themeFromDark, windowOptions } from "./window";

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

  it.each(["darwin", "win32", "linux"] as const)(
    "%s: «Undo»/«Redo» non sono ruoli nativi: mandano il loro canale (difetto 2 del 7 nov)",
    (platform) => {
      const send = vi.fn();
      const edit = buildMenuTemplate(platform, "Stubwise", send).find((i) => i.label === "Edit")!;
      const items = edit.submenu as MenuItemConstructorOptions[];
      const undo = items.find((i) => i.label === "Undo");
      const redo = items.find((i) => i.label === "Redo");
      expect(items.some((i) => i.role === "undo" || i.role === "redo")).toBe(false);
      expect(undo?.accelerator).toBe("CmdOrCtrl+Z");
      expect(redo?.accelerator).toBe("Shift+CmdOrCtrl+Z");
      (undo?.click as () => void)();
      (redo?.click as () => void)();
      expect(send.mock.calls).toEqual([[MENU_UNDO], [MENU_REDO]]);
    },
  );
});

// I canali IPC, letti dal sorgente: `theme:changed`, i `menu:*`, dall'area
// 11a `file:save` (decisione 8 della spec) e, dall'integrazione area 2 (fetta
// 1, Task 13), `api:request`, `instance:get|set`, `session:login|logout|status`
// e `open:web`. Un canale in più (o scelto dal renderer) fa fallire questo
// test. Il preload espone solo `window.stubwise` con le sue otto voci.
describe("canali IPC", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const main = read("./index.ts");
  const preload = read("../preload/index.ts");
  const EXPECTED = [
    "api:request",
    "file:save",
    "instance:get",
    "instance:set",
    "menu:ask-claude",
    "menu:preferences",
    "menu:redo",
    "menu:search",
    "menu:undo",
    "open:web",
    "session:cancel-browser-login",
    "session:changed",
    "session:login",
    "session:logout",
    "session:start-browser-login",
    "session:status",
    "theme:changed",
  ];

  /** I nomi dei canali: ogni stringa `<parola>:<parola>` che non sia un import `node:`. */
  const channelsIn = (source: string) =>
    [...source.matchAll(/["'`]([a-z]+:[a-z-]+)["'`]/g)].map((m) => m[1]!).filter((c) => !c.startsWith("node:"));

  it("main e preload nominano solo i canali attesi, file:save compreso", () => {
    const all = new Set([
      ...channelsIn(main),
      ...channelsIn(preload),
      ...Object.values({ MENU_SEARCH, MENU_PREFERENCES, MENU_ASK_CLAUDE, MENU_UNDO, MENU_REDO }),
    ]);
    expect([...all].sort()).toEqual(EXPECTED);
    expect(main).toMatch(/ipcMain\.handle\("file:save",/);
    expect(preload).toMatch(/ipcRenderer\.invoke\("file:save",/);
  });

  it("nessuna chiamata IPC con un canale che non sia letterale (tranne i menu della lista fissa)", () => {
    const calls = [...`${main}\n${preload}`.matchAll(/ipc(?:Main|Renderer)\.(on|handle|send|invoke|once)\(\s*([^,)]+)/g)];
    const dynamic = calls.map((m) => m[2]!.trim()).filter((arg) => !/^"[a-z]+:[a-z-]+"$/.test(arg));
    expect(dynamic).toEqual(["channel"]);
  });

  it("il login col browser: protocollo stubwise://, una sola istanza, URL solo a handleAuthUrl", () => {
    expect(main).toMatch(/setAsDefaultProtocolClient\("stubwise"/);
    expect(main).toMatch(/requestSingleInstanceLock\(\)/);
    // macOS consegna l'URL con `open-url`, Windows/Linux alla seconda istanza.
    // Entrambi passano da `receiveAuthUrl`, che consegna l'URL al solo `handleAuthUrl`.
    expect(main).toMatch(/function receiveAuthUrl\([^)]*\)[\s\S]*?browserLogin\.handleAuthUrl\(url\)/);
    expect(main).toMatch(/app\.on\("open-url",[\s\S]*?receiveAuthUrl\(url\)/);
    expect(main).toMatch(/app\.on\("second-instance",[\s\S]*?authUrlFromArgv\(argv\)[\s\S]*?receiveAuthUrl\(url\)/);
    // Niente più login con password dal desktop: il canale resta solo come risposta di ripiego.
    expect(main).not.toMatch(/mobile-login/);
    const builder = read("../../electron-builder.yml");
    expect(builder).toMatch(/protocols:\s*\n\s*- name: Stubwise\s*\n\s*schemes:\s*\n\s*- stubwise/);
  });

  it("file:save guarda il frame mittente PRIMA di leggere gli argomenti", () => {
    const handler = main.slice(main.indexOf('ipcMain.handle("file:save"'));
    const sender = handler.indexOf("fromApp(event)");
    const parse = handler.indexOf("parseSaveFileRequest(");
    expect(sender).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(sender).toBeLessThan(parse);
    // `fromApp` è la regola della navigazione sul frame mittente.
    expect(main).toMatch(/function fromApp\([^)]*\)[^{]*\{\s*const sender = event\.senderFrame\?\.url \?\? "";\s*return isNavigationAllowed\(sender,/);
  });

  it("ogni ipcMain.handle guarda il mittente come prima cosa", () => {
    const channels = [...main.matchAll(/ipcMain\.handle\("([a-z]+:[a-z-]+)",/g)].map((m) => m[1]!);
    expect(channels.sort()).toEqual([
      "api:request",
      "file:save",
      "instance:get",
      "instance:set",
      "open:web",
      "session:cancel-browser-login",
      "session:login",
      "session:logout",
      "session:start-browser-login",
      "session:status",
    ]);
    for (const channel of channels) {
      // L'intestazione e le prime due righe del corpo: il controllo sta lì, prima di tutto.
      const head = main.slice(main.indexOf(`ipcMain.handle("${channel}",`)).split("\n").slice(0, 3).join("\n");
      expect(head, channel).toMatch(/fromApp\(event\)/);
    }
  });

  it("il preload espone solo platform, setTheme, onMenu, saveFile, api, instance, session e openWeb", () => {
    const exposed = preload.match(/exposeInMainWorld\("stubwise", \{([\s\S]*)\}\);/)?.[1] ?? "";
    const keys = [...exposed.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "platform",
      "setTheme",
      "onMenu",
      "saveFile",
      "api",
      "instance",
      "session",
      "openWeb",
    ]);
    // Mai il token né `ipcRenderer` verso il renderer.
    expect(exposed).not.toMatch(/\btoken\s*[:(]/i);
    expect(exposed).not.toMatch(/:\s*ipcRenderer\b/);
  });
});

describe("PDF su carta bianca", () => {
  function fakeWindow(ground: string) {
    let color = ground;
    const seen: string[] = [];
    return {
      seen,
      getBackgroundColor: () => color,
      setBackgroundColor: (c: string) => {
        color = c;
      },
      print: () => {
        seen.push(color);
        return Promise.resolve("pdf");
      },
    };
  }

  it("i margini prendono il fondo della finestra: durante la stampa è bianco, poi torna il tema", async () => {
    const win = fakeWindow("#121314");
    await expect(printOnPaper(win, win.print)).resolves.toBe("pdf");
    expect(win.seen).toEqual([PAPER]);
    expect(win.getBackgroundColor()).toBe("#121314");
  });

  it("anche se la stampa fallisce il fondo torna quello del tema", async () => {
    const win = fakeWindow("#f7f8fa");
    await expect(printOnPaper(win, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(win.getBackgroundColor()).toBe("#f7f8fa");
  });
});
