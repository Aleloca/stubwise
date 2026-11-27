import { beforeEach, describe, expect, it } from "vitest";
import { getRequest, removeRequestDesign, removeRequestPlan, resetApi, setLatency } from "./api";
import { setSessionPersonId } from "./session";

// Togliere design e piano da una richiesta (shape `design-plan-remove.md`,
// DP-Q1): chi ha `backlog.edit`; la descrizione resta com'è.

beforeEach(() => {
  resetApi();
  setLatency(0);
});

describe("togliere design e piano da una richiesta", () => {
  it("il design va via e la descrizione resta; poi il piano", async () => {
    setSessionPersonId("p-laura");
    const before = (await getRequest("req-aud-2"))!;
    expect(before.design).toBeTruthy();
    expect(before.plan).toBeTruthy();
    const afterDesign = await removeRequestDesign("req-aud-2");
    expect(afterDesign.design).toBeNull();
    expect(afterDesign.description).toBe(before.description);
    expect(afterDesign.plan).toBe(before.plan);
    expect((await removeRequestPlan("req-aud-2")).plan).toBeNull();
  });

  it("senza `backlog.edit` è vietato, e niente cambia", async () => {
    setSessionPersonId("p-sara");
    await expect(removeRequestDesign("req-aud-2")).rejects.toThrow(/forbidden|not_found/);
    setSessionPersonId("p-laura");
    expect((await getRequest("req-aud-2"))!.design).toBeTruthy();
  });
});
