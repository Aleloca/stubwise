import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { usePinnedProjects } from "../data/queries";
import { hasModKey } from "../platform/platform";

/** Evento che apre la palette dei comandi (la palette arriva in un task successivo). */
export const PALETTE_EVENT = "stubwise:palette";
/** Evento che apre il pannello delle notifiche. */
export const NOTIFICATIONS_EVENT = "stubwise:notifications";

/** `open` apre sempre (voce di menu); `toggle` (default) alterna (⌘K, bottone). */
export interface PaletteEventDetail {
  mode: "open" | "toggle";
}

export function openPalette(mode: PaletteEventDetail["mode"] = "toggle"): void {
  window.dispatchEvent(new CustomEvent<PaletteEventDetail>(PALETTE_EVENT, { detail: { mode } }));
}

export function openNotifications(): void {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_EVENT));
}

/**
 * Scorciatoie globali dell'app, con il modificatore della piattaforma
 * (⌘ su mac, Ctrl altrove): mod+1…9 apre la tessera N del binario, mod+K
 * apre la palette, mod+N il nuovo messaggio della Chat, mod+Shift+H torna
 * alla Home. mod+0 e un numero oltre
 * l'ultima tessera non fanno nulla.
 */
export function useShortcuts(): void {
  const navigate = useNavigate();
  const { data: pinned } = usePinnedProjects();
  // Il listener resta uno solo: legge i progetti fissati correnti da qui.
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!hasModKey(e) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === "h") {
          e.preventDefault();
          void navigate({ to: "/home" });
        }
        return;
      }
      if (key === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (key === "n") {
        // «New message» della Chat, sopra la pagina (come la palette).
        e.preventDefault();
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({ ...prev, newMessage: "1" }),
        } as never);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const project = pinnedRef.current?.[Number(key) - 1];
        if (!project) return;
        e.preventDefault();
        void navigate({ to: "/p/$code", params: { code: project.code } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
