import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_PANEL_EVENT, claimPanelToggle, resetPanelToggle } from "./claudePanel/panelEvents";
import { handleMenuChannel } from "./useMenuEvents";
import { PALETTE_EVENT } from "./useShortcuts";

// La pressione appena vista resta di modulo: ogni test parte da capo.
afterEach(resetPanelToggle);

describe("handleMenuChannel", () => {
  it("menu:search apre la palette, senza navigare", () => {
    const palette = vi.fn();
    const navigate = vi.fn();
    window.addEventListener(PALETTE_EVENT, palette);
    try {
      handleMenuChannel("menu:search", navigate);
    } finally {
      window.removeEventListener(PALETTE_EVENT, palette);
    }
    expect(palette).toHaveBeenCalledTimes(1);
    // Apre, non alterna: il keydown del renderer alterna già per conto suo.
    expect((palette.mock.calls[0]![0] as CustomEvent).detail).toEqual({ mode: "open" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("menu:preferences porta a /preferences", () => {
    const navigate = vi.fn();
    handleMenuChannel("menu:preferences", navigate);
    expect(navigate).toHaveBeenCalledWith("/preferences");
  });

  it("menu:ask-claude alterna il riquadro di Claude, senza navigare", () => {
    const panel = vi.fn();
    const navigate = vi.fn();
    window.addEventListener(CLAUDE_PANEL_EVENT, panel);
    try {
      handleMenuChannel("menu:ask-claude", navigate);
    } finally {
      window.removeEventListener(CLAUDE_PANEL_EVENT, panel);
    }
    expect(panel).toHaveBeenCalledTimes(1);
    expect((panel.mock.calls[0]![0] as CustomEvent).detail).toEqual({ mode: "toggle" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("⌘J premuto una volta: la tastiera e la voce di menu danno un solo toggle", () => {
    const panel = vi.fn();
    window.addEventListener(CLAUDE_PANEL_EVENT, panel);
    try {
      // La stessa pressione arriva al renderer e (via acceleratore) al menu.
      expect(claimPanelToggle("key")).toBe(true);
      handleMenuChannel("menu:ask-claude", vi.fn());
      expect(panel).not.toHaveBeenCalled();
      // E nell'ordine opposto.
      handleMenuChannel("menu:ask-claude", vi.fn());
      expect(panel).toHaveBeenCalledTimes(1);
      expect(claimPanelToggle("key")).toBe(false);
    } finally {
      window.removeEventListener(CLAUDE_PANEL_EVENT, panel);
    }
  });

  it("P20: con un dialogo modale aperto la voce di menu non apre il riquadro", () => {
    const panel = vi.fn();
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    window.addEventListener(CLAUDE_PANEL_EVENT, panel);
    try {
      handleMenuChannel("menu:ask-claude", vi.fn());
    } finally {
      window.removeEventListener(CLAUDE_PANEL_EVENT, panel);
      modal.remove();
    }
    expect(panel).not.toHaveBeenCalled();
  });

  it("un canale sconosciuto non fa nulla", () => {
    const navigate = vi.fn();
    handleMenuChannel("menu:other", navigate);
    expect(navigate).not.toHaveBeenCalled();
  });
});
