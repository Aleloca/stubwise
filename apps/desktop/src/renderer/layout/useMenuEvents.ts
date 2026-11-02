import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { claimPanelToggle, openClaudePanel } from "./claudePanel/panelEvents";
import { openPalette } from "./useShortcuts";

/** Mappa una voce del menu dell'app sull'azione del renderer. */
export function handleMenuChannel(channel: string, navigate: (to: string) => void): void {
  if (channel === "menu:search") openPalette("open");
  else if (channel === "menu:preferences") navigate("/preferences");
  else if (channel === "menu:ask-claude") {
    // Come ⌘J dalla tastiera (P20): con un dialogo modale aperto il tasto è
    // suo, e la stessa pressione arrivata anche come keydown non alterna due volte.
    if (document.querySelector('[aria-modal="true"]')) return;
    if (claimPanelToggle("menu")) openClaudePanel({ mode: "toggle" });
  }
}

/**
 * Le voci del menu dell'app (create nel main) arrivano via `window.stubwise.onMenu`:
 * «Search…» apre la palette, «Ask Claude…» alterna il riquadro di Claude,
 * «Preferences…» porta a /preferences.
 */
export function useMenuEvents(): void {
  const navigate = useNavigate();
  useEffect(() => {
    return window.stubwise?.onMenu?.((channel) =>
      handleMenuChannel(channel, (to) => void navigate({ to })),
    );
  }, [navigate]);
}
