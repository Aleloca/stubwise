import { describe, expect, it } from "vitest";
import { batches, ID_BATCH } from "./task-view.js";

// Revisione 8–9 (M-12): gli id a lotti, sotto il tetto dei parametri di Postgres.
describe("batches", () => {
  it("spezza in lotti della misura data, senza perdere né duplicare, e un elenco vuoto non fa lotti", () => {
    const ids = Array.from({ length: 12_345 }, (_, i) => `id-${i}`);
    const out = batches(ids);
    expect(out.map((b) => b.length)).toEqual([ID_BATCH, ID_BATCH, 2_345]);
    expect(out.flat()).toEqual(ids);
    expect(batches([])).toEqual([]);
    expect(ID_BATCH).toBeLessThan(65_535);
  });
});
