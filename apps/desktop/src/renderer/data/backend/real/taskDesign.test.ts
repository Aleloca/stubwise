import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { createRealTaskDesign, type TaskDesignApi } from "./taskDesign";

// Design e piano di una task nella build app (shape `design-plan-remove.md`,
// DP-Q2b): dal dettaglio del ticket. Con un design attivo il corpo È il
// design e l'originale sta in `originContent`.

const T = "11111111-1111-4111-8111-111111111111";

const fakeApi = (detail: { body: string; originContent: string | null; implementationPlan: string | null }, over: Partial<TaskDesignApi> = {}): TaskDesignApi => ({
  detail: vi.fn(async () => detail),
  remove: vi.fn(async () => undefined),
  ...over,
});

describe("design e piano di una task, dal server", () => {
  it("con un design attivo: il design è il corpo, l'originale a parte; il piano è il suo campo", async () => {
    const real = createRealTaskDesign(fakeApi({ body: "## Design", originContent: "Users want CSV.", implementationPlan: "1. Do it" }));
    expect(await real.getTaskDesignPlan(T)).toEqual({ design: "## Design", plan: "1. Do it", original: "Users want CSV." });
  });

  it("senza design: niente design, niente originale", async () => {
    const real = createRealTaskDesign(fakeApi({ body: "Users want CSV.", originContent: null, implementationPlan: null }));
    expect(await real.getTaskDesignPlan(T)).toEqual({ design: null, plan: null, original: null });
  });

  it("togliere: il DELETE della rotta; già tolto (404) non è un errore, un 403 sì", async () => {
    const api = fakeApi({ body: "", originContent: null, implementationPlan: null });
    await createRealTaskDesign(api).removeTaskDesign(T);
    expect(api.remove).toHaveBeenCalledWith(T, "design");
    const gone = createRealTaskDesign(
      fakeApi({ body: "", originContent: null, implementationPlan: null }, {
        remove: vi.fn(async () => Promise.reject(new ApiError(404, "x", "no_active_design"))),
      }),
    );
    await expect(gone.removeTaskPlan(T)).resolves.toBeUndefined();
    const denied = createRealTaskDesign(
      fakeApi({ body: "", originContent: null, implementationPlan: null }, {
        remove: vi.fn(async () => Promise.reject(new ApiError(403, "x", "forbidden"))),
      }),
    );
    await expect(denied.removeTaskDesign(T)).rejects.toBeInstanceOf(ApiError);
  });
});
