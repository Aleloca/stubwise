import { describe, expect, it } from "vitest";
import { mapLimit } from "./map-limit.js";

/** Un tetto alle query in parallelo (il portafoglio, fetta 4): mai più di `limit` in volo, e l'ordine dei risultati è quello dell'input. */
describe("mapLimit", () => {
  it("mai più di `limit` in volo; i risultati nell'ordine dell'input", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([...Array(12).keys()], 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 12 - n));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(out).toEqual([...Array(12).keys()].map((n) => n * 2));
  });

  it("un errore si propaga", async () => {
    await expect(mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("no");
      return n;
    })).rejects.toThrow("no");
  });

  it("vuoto → vuoto", async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});
