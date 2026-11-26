import { describe, expect, it } from "vitest";
import { AI_MODEL_IDS } from "./ai-operations.js";
import { estimateCostUsd } from "./ai-pricing.js";

describe("estimateCostUsd (review F3, punto 8: il budget conta anche le chiamate dirette del server)", () => {
  it("dai token, con le tariffe per milione: input, output, lettura e scrittura della cache", () => {
    // Opus 5.5: 4 $ input, 20 $ output, 0,20 $ lettura, 5 $ scrittura (1,25×).
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 })).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeCloseTo(0.004 + 0.005, 9);
  });

  it("ogni modello del catalogo ha una tariffa; un modello sconosciuto dà null (mai uno zero inventato)", () => {
    for (const model of AI_MODEL_IDS) expect(estimateCostUsd(model, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 })).not.toBeNull();
    expect(estimateCostUsd("claude-sconosciuto", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });
});
