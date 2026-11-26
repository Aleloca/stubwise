import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dei webhook (area 9, F3): passano dal client.

const webhooks = {
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  rotateSecret: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
  test: vi.fn(async () => ({})),
  preview: vi.fn(async () => ({})),
};
vi.mock("./client", () => ({ appClient: () => ({ webhooks }) }));

describe("i webhook, i percorsi veri", () => {
  it("elenco, crea, modifica, segreto, elimina, prova e anteprima dal client.webhooks", async () => {
    const { liveWebhooksApiForTest: api } = await import("./webhooks");
    await api.list();
    await api.create({
      name: "N",
      url: "https://x.test",
      format: "slack",
      enabled: true,
      events: [],
    });
    await api.update("w1", { name: "M" });
    await api.rotateSecret("w1");
    await api.remove("w1");
    await api.test("w1");
    await api.preview("discord", "job.failed");
    expect(webhooks.list).toHaveBeenCalled();
    expect(webhooks.create).toHaveBeenCalledWith({
      name: "N",
      url: "https://x.test",
      format: "slack",
      enabled: true,
      events: [],
    });
    expect(webhooks.update).toHaveBeenCalledWith("w1", { name: "M" });
    expect(webhooks.rotateSecret).toHaveBeenCalledWith("w1");
    expect(webhooks.remove).toHaveBeenCalledWith("w1");
    expect(webhooks.test).toHaveBeenCalledWith("w1");
    expect(webhooks.preview).toHaveBeenCalledWith("discord", "job.failed");
  });
});
