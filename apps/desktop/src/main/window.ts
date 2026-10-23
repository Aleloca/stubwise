/**
 * Funzioni pure della finestra: nessun import di `electron`, così si
 * testano in node. I colori sono la copia esadecimale dei token di
 * `renderer/styles/tokens.css` (`--ground`, `--ink`): se cambiano là, qui.
 */
export type ResolvedTheme = "light" | "dark";

export const GROUND: Record<ResolvedTheme, string> = {
  dark: "#121314", // oklch(0.185 0.004 265)
  light: "#f8f9fa", // oklch(0.982 0.002 265)
};
const INK: Record<ResolvedTheme, string> = {
  dark: "#f5f3ef", // oklch(0.965 0.006 85)
  light: "#151618", // oklch(0.2 0.005 265)
};

/** Altezza dei controlli finestra di Windows (overlay). */
export const OVERLAY_HEIGHT = 32;
/** Il binario è largo 64 px; i semafori (52 px) ci stanno centrati, sopra il logo. */
export const TRAFFIC_LIGHT_POSITION = { x: 6, y: 12 } as const;

export function groundFor(theme: ResolvedTheme): string {
  return GROUND[theme];
}

export function themeFromDark(shouldUseDark: boolean): ResolvedTheme {
  return shouldUseDark ? "dark" : "light";
}

export function overlayFor(theme: ResolvedTheme) {
  return { color: GROUND[theme], symbolColor: INK[theme], height: OVERLAY_HEIGHT };
}

/** Opzioni di `BrowserWindow` che dipendono dalla piattaforma e dal tema. */
export function windowOptions(platform: NodeJS.Platform, theme: ResolvedTheme) {
  const base = { backgroundColor: GROUND[theme] };
  if (platform === "darwin") {
    return {
      ...base,
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
    };
  }
  if (platform === "win32") {
    return { ...base, titleBarStyle: "hidden" as const, titleBarOverlay: overlayFor(theme) };
  }
  return base;
}

export function isResolvedTheme(v: unknown): v is ResolvedTheme {
  return v === "light" || v === "dark";
}
