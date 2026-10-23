import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { openPalette } from "./useShortcuts";

/** Mappa una voce del menu dell'app sull'azione del renderer. */
export function handleMenuChannel(channel: string, navigate: (to: string) => void): void {
  if (channel === "menu:search") openPalette();
  else if (channel === "menu:preferences") navigate("/preferences");
}

/**
 * Le voci del menu dell'app (create nel main) arrivano via `window.stubwise.onMenu`:
 * «Search…» apre la palette, «Preferences…» porta a /preferences.
 */
export function useMenuEvents(): void {
  const navigate = useNavigate();
  useEffect(() => {
    return window.stubwise?.onMenu?.((channel) =>
      handleMenuChannel(channel, (to) => void navigate({ to })),
    );
  }, [navigate]);
}
