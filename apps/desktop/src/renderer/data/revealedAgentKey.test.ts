import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./servers/monitor";
import { resetApi } from "./api";
import { setSessionPersonId } from "./session";
import {
  AGENT_KEY_KEPT_MS,
  forgetRevealedAgentKeys,
  revealAgentKey,
  takeAgentKey,
} from "./revealedAgentKey";
import { createServerAndReveal, regenerateAndReveal } from "./queries/servers";

// Area 8, F4a (I2): la chiave dell'agente non resta nel risultato della
// scrittura (la cache delle mutazioni la terrebbe): la prende il pannello,
// una volta, e al cambio di persona sparisce.

afterEach(() => {
  forgetRevealedAgentKeys();
  resetApi();
});

describe("la chiave dell'agente, una volta sola (I2)", () => {
  it("si prende una volta; poi non c'è più", () => {
    revealAgentKey("SRV-9", { key: "sk_x" });
    expect(takeAgentKey("SRV-9")).toEqual({ key: "sk_x" });
    expect(takeAgentKey("SRV-9")).toBeUndefined();
  });

  it("creare e rigenerare: il risultato non porta la chiave, il pannello sì", async () => {
    setSessionPersonId("p-roberta");
    const created = await createServerAndReveal({ name: "fresh", environmentId: null });
    expect(JSON.stringify(created)).not.toContain("sk_");
    expect(takeAgentKey(created.server.code)?.key).toMatch(/^sk_/);
    const again = await regenerateAndReveal(created.server.code);
    expect(JSON.stringify(again ?? null)).not.toContain("sk_");
    expect(takeAgentKey(created.server.code)?.key).toMatch(/^sk_/);
    // Il livello dati del prototipo la dà ancora: è il risultato del hook che non la porta.
    expect((await createServer({ name: "other", environmentId: null })).agentKey).toMatch(/^sk_/);
  });

  it("non resta oltre il tempo del pannello (review F4a, M3)", () => {
    vi.useFakeTimers();
    try {
      revealAgentKey("SRV-8", { key: "sk_y" });
      vi.advanceTimersByTime(AGENT_KEY_KEPT_MS + 1);
      expect(takeAgentKey("SRV-8")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
