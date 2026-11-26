import { beforeEach, describe, expect, it, vi } from "vitest";

// Area 9, F4: perché un lavoro nuovo di Claude non partirebbe nel progetto.
// Prima il budget del mese (vince sugli avvii), poi la coda del progetto in
// pausa, dalla vista del progetto (72, 5713037b2).

const claude = { status: vi.fn(async () => ({ budgetExhausted: false })) };
const projects = {
  get: vi.fn(async () => ({ queuePause: null as unknown })),
};
vi.mock("./client", () => ({ appClient: () => ({ claude, projects }) }));

beforeEach(() => {
  claude.status.mockResolvedValue({ budgetExhausted: false });
  projects.get.mockResolvedValue({ queuePause: null });
});

describe("il blocco di Claude nel progetto", () => {
  it("la coda in pausa, col nome del server", async () => {
    const { chatAiBlock } = await import("./claudeChat");
    projects.get.mockResolvedValue({
      queuePause: { byId: "u1", byName: "Roberta Fontana", since: "2026-11-18T08:00:00.000Z" },
    });
    expect(await chatAiBlock("p1")).toEqual({
      reason: "queue_paused",
      byId: "u1",
      byName: "Roberta Fontana",
      since: "2026-11-18T08:00:00.000Z",
    });
  });

  it("il budget vince sulla pausa; senza niente, nessun blocco", async () => {
    const { chatAiBlock } = await import("./claudeChat");
    claude.status.mockResolvedValue({ budgetExhausted: true });
    projects.get.mockResolvedValue({
      queuePause: { byId: "u1", byName: "R", since: "2026-11-18T08:00:00.000Z" },
    });
    expect(await chatAiBlock("p1")).toEqual({ reason: "monthly_budget" });
    claude.status.mockResolvedValue({ budgetExhausted: false });
    projects.get.mockResolvedValue({ queuePause: null });
    expect(await chatAiBlock("p1")).toBeNull();
    expect(await chatAiBlock(null)).toBeNull();
  });
});
