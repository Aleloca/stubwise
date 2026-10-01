import { describe, expect, it } from "vitest";
import { createDeliveryDedupe } from "./pr-correction-webhook.js";

describe("createDeliveryDedupe", () => {
  it("un id si prende una volta sola dentro la finestra", () => {
    const dedupe = createDeliveryDedupe(5 * 60_000, () => 0);
    expect(dedupe.claim("d1")).toBe(true);
    expect(dedupe.claim("d1")).toBe(false);
    expect(dedupe.claim("d2")).toBe(true);
  });

  it("release libera l'id: il ritentativo dopo un errore passa", () => {
    const dedupe = createDeliveryDedupe(5 * 60_000, () => 0);
    expect(dedupe.claim("d1")).toBe(true);
    dedupe.release("d1");
    expect(dedupe.claim("d1")).toBe(true);
  });

  it("oltre la finestra lo stesso id torna nuovo", () => {
    let now = 0;
    const dedupe = createDeliveryDedupe(1_000, () => now);
    expect(dedupe.claim("d1")).toBe(true);
    now = 999;
    expect(dedupe.claim("d1")).toBe(false);
    now = 1_000;
    expect(dedupe.claim("d1")).toBe(true);
  });
});
