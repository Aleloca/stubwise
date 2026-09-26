import { resetViewPings, shouldPingView, VIEW_PING_TTL_MS } from "./view-ping";

/** Il conteggio delle visite, come `useViewPing` del web: una volta per pagina ogni 10 minuti. */
describe("shouldPingView", () => {
  beforeEach(() => resetViewPings());

  test("la prima volta sì, entro il TTL no, dopo il TTL di nuovo sì", () => {
    expect(shouldPingView("r1", "a", 0)).toBe(true);
    expect(shouldPingView("r1", "a", VIEW_PING_TTL_MS - 1)).toBe(false);
    expect(shouldPingView("r1", "a", VIEW_PING_TTL_MS)).toBe(true);
  });

  test("la chiave è repository+slug: lo stesso slug in un altro repository conta", () => {
    expect(shouldPingView("r1", "a", 0)).toBe(true);
    expect(shouldPingView("r2", "a", 0)).toBe(true);
    expect(shouldPingView("r1", "b", 0)).toBe(true);
  });

  test("10 minuti, come il web", () => {
    expect(VIEW_PING_TTL_MS).toBe(10 * 60_000);
  });
});
