import { describe, expect, it, vi } from "vitest";
import { openRecentRoute } from "./recent-route";

// Una voce dei recenti scritta dalla nuova app (`#/p/AUD/tasks?task=AUD-9`) nel
// web vecchio: si apre nella nuova app, non come una route del web (revisione
// di feat/ritiro-buchi-minori, I1 b).

describe("openRecentRoute", () => {
  it("una route della nuova app va su /app/, a pagina intera", () => {
    const navigate = vi.fn();
    const assign = vi.fn();
    openRecentRoute("#/p/AUD/tasks?task=AUD-9", navigate, assign);
    expect(assign).toHaveBeenCalledWith("/app/#/p/AUD/tasks?task=AUD-9");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("una route del web vecchio resta una navigazione del web", () => {
    const navigate = vi.fn();
    const assign = vi.fn();
    openRecentRoute("/tickets/7", navigate, assign);
    expect(navigate).toHaveBeenCalledWith("/tickets/7");
    expect(assign).not.toHaveBeenCalled();
  });
});
