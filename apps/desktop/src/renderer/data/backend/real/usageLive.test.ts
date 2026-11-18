import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dei consumi (area 9, F4): passano dal client.

const usage = { summary: vi.fn(async () => ({ totals: {}, byDay: [], rows: [] })) };
vi.mock("./client", () => ({ appClient: () => ({ usage }) }));

describe("i consumi, i percorsi veri", () => {
  it("la lettura dal client.usage", async () => {
    const { liveUsageApiForTest: api } = await import("./usage");
    await api.summary({ range: { month: true }, groupBy: "day" });
    expect(usage.summary).toHaveBeenCalledWith({ range: { month: true }, groupBy: "day" });
  });
});
