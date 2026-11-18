import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dello Stato dell'istanza (area 9, F4): passano dal client.

const instance = { status: vi.fn(async () => ({})), retryJob: vi.fn(async () => ({})) };
const projects = {
  pauseQueue: vi.fn(async () => undefined),
  resumeQueue: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ instance, projects }) }));

describe("lo Stato dell'istanza, i percorsi veri", () => {
  it("la lettura dal client.instance", async () => {
    const { liveInstanceStatusApiForTest: api } = await import("./instanceStatus");
    await api.status();
    await api.pauseQueue("p1");
    await api.resumeQueue("p1");
    await api.retryJob("j1");
    expect(instance.status).toHaveBeenCalled();
    expect(projects.pauseQueue).toHaveBeenCalledWith("p1");
    expect(projects.resumeQueue).toHaveBeenCalledWith("p1");
    expect(instance.retryJob).toHaveBeenCalledWith("j1");
  });
});
