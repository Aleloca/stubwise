import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dello Stato dell'istanza (area 9, F4): passano dal client.

const instance = { status: vi.fn(async () => ({})) };
vi.mock("./client", () => ({ appClient: () => ({ instance }) }));

describe("lo Stato dell'istanza, i percorsi veri", () => {
  it("la lettura dal client.instance", async () => {
    const { liveInstanceStatusApiForTest: api } = await import("./instanceStatus");
    await api.status();
    expect(instance.status).toHaveBeenCalled();
  });
});
