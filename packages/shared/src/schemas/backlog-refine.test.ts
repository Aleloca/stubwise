import { describe, expect, it } from "vitest";
import {
  REFINE_DOC_MAX_CHARS,
  REFINE_TOOL_NAMES,
  refineSetDocInputSchema,
  refineUpdateItemInputSchema,
  startRefineSessionInputSchema,
} from "./backlog-refine.js";

describe("backlog-refine", () => {
  it("i nomi dei tool sono quelli che il CLI vede (mcp__<server>__<tool>)", () => {
    expect(REFINE_TOOL_NAMES).toEqual([
      "mcp__stubwise_refine__set_design",
      "mcp__stubwise_refine__set_plan",
      "mcp__stubwise_refine__update_item",
    ]);
  });

  it("set_design/set_plan: markdown non vuoto, entro il tetto", () => {
    expect(refineSetDocInputSchema.safeParse({ markdown: "" }).success).toBe(false);
    expect(refineSetDocInputSchema.safeParse({ markdown: "x".repeat(REFINE_DOC_MAX_CHARS + 1) }).success).toBe(false);
    expect(refineSetDocInputSchema.parse({ markdown: "# D" }).markdown).toBe("# D");
  });

  it("update_item: gli stessi validatori del PATCH, senza status, almeno un campo", () => {
    expect(refineUpdateItemInputSchema.safeParse({}).success).toBe(false);
    expect(refineUpdateItemInputSchema.safeParse({ effort: 9 }).success).toBe(false);
    expect(refineUpdateItemInputSchema.safeParse({ risk: "enorme" }).success).toBe(false);
    expect(refineUpdateItemInputSchema.parse({ status: "archived", title: "T" })).toEqual({ title: "T" });
    expect(refineUpdateItemInputSchema.parse({ riskNote: null })).toEqual({ riskNote: null });
  });

  it("avvio: messaggio facoltativo, trim, mai vuoto", () => {
    expect(startRefineSessionInputSchema.parse({})).toEqual({});
    expect(startRefineSessionInputSchema.safeParse({ message: "   " }).success).toBe(false);
    expect(startRefineSessionInputSchema.parse({ message: " ciao " }).message).toBe("ciao");
  });
});
