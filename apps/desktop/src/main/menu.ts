import type { MenuItemConstructorOptions } from "electron";

/** Canali IPC main → renderer del menu. */
export const MENU_SEARCH = "menu:search";
export const MENU_PREFERENCES = "menu:preferences";
/** Area 10a ([CP 7]): apre e chiude il riquadro di Claude. */
export const MENU_ASK_CLAUDE = "menu:ask-claude";

/**
 * Menu dell'applicazione. Le voci «Search…», «Ask Claude…» e «Preferences…»
 * non fanno nulla da sole: dicono al renderer (`send`) cosa è stato scelto.
 * «Ask Claude…» sta accanto a «Search…» perché ⌘J si scopra dal menu.
 * Le etichette sono in inglese: il menu vive nel main, e localizzarlo vuole
 * la lingua del renderer via IPC (fuori dall'ossatura).
 */
export function buildMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  send: (channel: string) => void,
): MenuItemConstructorOptions[] {
  const search: MenuItemConstructorOptions = {
    label: "Search…",
    accelerator: "CmdOrCtrl+K",
    click: () => send(MENU_SEARCH),
  };
  const askClaude: MenuItemConstructorOptions = {
    label: "Ask Claude…",
    accelerator: "CmdOrCtrl+J",
    click: () => send(MENU_ASK_CLAUDE),
  };
  const preferences: MenuItemConstructorOptions = {
    label: "Preferences…",
    accelerator: "CmdOrCtrl+,",
    click: () => send(MENU_PREFERENCES),
  };
  const edit: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const help: MenuItemConstructorOptions = {
    label: "Help",
    role: "help",
    submenu: [{ label: `${appName} Help`, enabled: false }],
  };

  if (platform === "darwin") {
    return [
      {
        label: appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          preferences,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [search, askClaude, { type: "separator" }, { role: "close" }],
      },
      edit,
      view,
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
      },
      help,
    ];
  }
  return [
    {
      label: "File",
      submenu: [search, askClaude, preferences, { type: "separator" }, { role: "quit" }],
    },
    edit,
    view,
    help,
  ];
}
