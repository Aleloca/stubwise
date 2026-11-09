import { describe, expect, it } from "vitest";
import { ticketTypeFor, uiTypeOf } from "./types.js";

describe("tipi mostrati ↔ tipi del DB", () => {
  it("in lettura: feedback→feature, review→activity, task→activity", () => {
    expect(uiTypeOf("bug")).toBe("bug");
    expect(uiTypeOf("feature")).toBe("feature");
    expect(uiTypeOf("feedback")).toBe("feature");
    expect(uiTypeOf("review")).toBe("activity");
    expect(uiTypeOf("task")).toBe("activity");
  });

  it("in scrittura: activity→task, gli altri restano", () => {
    expect(ticketTypeFor("activity")).toBe("task");
    expect(ticketTypeFor("bug")).toBe("bug");
    expect(ticketTypeFor("feature")).toBe("feature");
  });
});
