/**
 * Piattaforma su cui gira il renderer, letta da `window.stubwise.platform`
 * (esposto dal preload). Senza preload — `preview:web`, test — è `web`.
 * Il tasto modificatore delle scorciatoie è ⌘ solo su mac; altrove Ctrl.
 */
export type Platform = "mac" | "windows" | "linux" | "web";

export function getPlatform(): Platform {
  switch (window.stubwise?.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "web";
  }
}

export function isMac(): boolean {
  return getPlatform() === "mac";
}

export function modKeyLabel(): "⌘" | "Ctrl" {
  return isMac() ? "⌘" : "Ctrl";
}

const MAC_KEYS: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const OTHER_KEYS: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
};

/**
 * Etichetta di una scorciatoia: `["mod", "K"]` → «⌘K» su mac, «Ctrl+K»
 * altrove. Ogni scorciatoia mostrata nella UI passa da qui.
 */
export function shortcutLabel(keys: string[]): string {
  const mac = isMac();
  const names = mac ? MAC_KEYS : OTHER_KEYS;
  const parts = keys.map((k) => names[k] ?? k);
  return mac ? parts.join("") : parts.join("+");
}

/** Vero se l'evento ha il modificatore della piattaforma (⌘ su mac, Ctrl altrove) e non l'altro. */
export function hasModKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Scrive la piattaforma su `<html data-platform>`: lo usa il CSS per ciò che
 * dipende dalla finestra (su Windows le testate delle pagine riservano lo
 * spazio dei controlli finestra, vedi `.page-header` in `tokens.css`).
 */
export function applyPlatformAttribute(): void {
  document.documentElement.dataset.platform = getPlatform();
}
