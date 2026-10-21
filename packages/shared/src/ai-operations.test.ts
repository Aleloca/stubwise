import { describe, expect, it } from "vitest";
import {
  AI_OPERATIONS,
  AI_OPERATION_GROUPS,
  CONFIGURABLE_AI_OPERATIONS,
  aiModelChoiceSchema,
  isConfigurableAiOperation,
  resolveApiModelId,
} from "./ai-operations.js";

describe("catalogo operazioni AI", () => {
  it("ogni operazione compare in esattamente un gruppo", () => {
    const all = AI_OPERATION_GROUPS.flatMap((g) => g.operations);
    expect([...all].sort()).toEqual([...AI_OPERATIONS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("le configurabili escludono le tre tecniche e contengono le altre 16", () => {
    for (const op of ["plugin_smoke", "credential_test", "usage_probe"] as const) {
      expect(CONFIGURABLE_AI_OPERATIONS).not.toContain(op);
      expect(isConfigurableAiOperation(op)).toBe(false);
    }
    expect(CONFIGURABLE_AI_OPERATIONS).toHaveLength(16);
    expect(isConfigurableAiOperation("triage")).toBe(true);
  });

  it("resolveApiModelId risolve gli alias e lascia gli id", () => {
    expect(resolveApiModelId("opus")).toBe("claude-opus-5-5");
    expect(resolveApiModelId("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveApiModelId("haiku")).toBe("claude-haiku-5-5");
    expect(resolveApiModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("rifiuta un modello fuori catalogo", () => {
    expect(aiModelChoiceSchema.safeParse("opsu").success).toBe(false);
    expect(aiModelChoiceSchema.safeParse("opus").success).toBe(true);
  });
});
