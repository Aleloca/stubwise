import { describe, expect, it, vi } from "vitest";
import { handleMenuChannel } from "./useMenuEvents";
import { PALETTE_EVENT } from "./useShortcuts";

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
    expect(navigate).not.toHaveBeenCalled();
  });

  it("menu:preferences porta a /preferences", () => {
    const navigate = vi.fn();
    handleMenuChannel("menu:preferences", navigate);
    expect(navigate).toHaveBeenCalledWith("/preferences");
  });

  it("un canale sconosciuto non fa nulla", () => {
    const navigate = vi.fn();
    handleMenuChannel("menu:other", navigate);
    expect(navigate).not.toHaveBeenCalled();
  });
});
