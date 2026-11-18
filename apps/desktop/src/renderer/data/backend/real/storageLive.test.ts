import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dell'archiviazione (area 9, F3): passano dal client.

const instanceSettings = {
  get: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
};
vi.mock("./client", () => ({ appClient: () => ({ instanceSettings }) }));

describe("l'archiviazione, i percorsi veri", () => {
  it("lettura e salvataggio dal client.instanceSettings", async () => {
    const { liveStorageApiForTest: api } = await import("./storage");
    await api.get();
    await api.save({ contentLanguage: "en", s3Bucket: "b" });
    expect(instanceSettings.get).toHaveBeenCalled();
    expect(instanceSettings.save).toHaveBeenCalledWith({ contentLanguage: "en", s3Bucket: "b" });
  });
});
