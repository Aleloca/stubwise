import { afterEach, describe, expect, it, vi } from "vitest";
import { supportRefreshMs } from "./queries";

// Area 8, F3 (R6): Support non ha uno stream. Nella build app il dettaglio
// aperto si rilegge ogni 15 s solo finché la conversazione è senza esito (in
// triage, non conclusa o bastata: un messaggio del cliente la riporta in
// triage). Chiusa con un esito non riceve più messaggi: si ferma. L'elenco
// ogni 30 s. Il prototipo cambia solo da sé.

afterEach(() => vi.unstubAllEnvs());

describe("il ritmo di Support", () => {
  it("nel prototipo non si rilegge da solo", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "prototype");
    expect(supportRefreshMs("detail", "triage")).toBe(false);
    expect(supportRefreshMs("list")).toBe(false);
  });

  it("nella build app il dettaglio ogni 15 s senza esito, 30 s chiusa; l'elenco ogni 30 s", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    for (const state of ["triage", "not_concluded", "answered"] as const) {
      expect(supportRefreshMs("detail", state)).toBe(15_000);
    }
    // Chiusa (con l'esito): ogni 30 s, perché la richiesta e «Continued in» cambiano ancora.
    expect(supportRefreshMs("detail", "request_open")).toBe(30_000);
    // Non ancora letta: niente ritmo.
    expect(supportRefreshMs("detail", undefined)).toBe(false);
    expect(supportRefreshMs("list")).toBe(30_000);
  });
});
