import { afterEach, describe, expect, it, vi } from "vitest";
import { supportRefreshMs } from "./queries";

// Area 8, F3 (R8): Support non ha uno stream. Nella build app il dettaglio
// aperto si rilegge ogni 15 s e l'elenco ogni 30 s (più le card `support.*`
// dell'inbox); il prototipo cambia solo da sé.

afterEach(() => vi.unstubAllEnvs());

describe("il ritmo di Support", () => {
  it("nel prototipo non si rilegge da solo", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "prototype");
    expect(supportRefreshMs("detail")).toBe(false);
    expect(supportRefreshMs("list")).toBe(false);
  });

  it("nella build app il dettaglio ogni 15 s, l'elenco (e «Clienti in attesa») ogni 30 s", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(supportRefreshMs("detail")).toBe(15_000);
    expect(supportRefreshMs("list")).toBe(30_000);
  });
});
