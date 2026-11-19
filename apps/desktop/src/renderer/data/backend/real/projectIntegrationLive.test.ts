import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di Integration (area 9, F5): passano dal client.

const projects = {
  integration: vi.fn(async () => ({})),
  get: vi.fn(async () => ({})),
  regenerateIngestionKey: vi.fn(async () => ({ ingestionKey: "k" })),
};
const repositories = { regenerateWebhookSecret: vi.fn(async () => ({ mode: "manual" })) };
vi.mock("./client", () => ({ appClient: () => ({ projects, repositories }) }));

describe("Integration, i percorsi veri", () => {
  it("lettura, progetto e rigenerazioni dal client", async () => {
    const { liveIntegrationApiForTest: api } = await import("./projectIntegration");
    await api.integration("p1");
    await api.project("p1");
    await api.regenerateIngestionKey("p1");
    await api.regenerateWebhookSecret("portale-utenti");
    expect(projects.integration).toHaveBeenCalledWith("p1");
    expect(projects.get).toHaveBeenCalledWith("p1");
    expect(projects.regenerateIngestionKey).toHaveBeenCalledWith("p1");
    expect(repositories.regenerateWebhookSecret).toHaveBeenCalledWith("portale-utenti");
  });
});
