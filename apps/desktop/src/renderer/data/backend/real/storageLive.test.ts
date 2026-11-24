import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero dell'archiviazione (area 9, F3): passano dal client.

const instanceSettings = {
  get: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
};
const request = vi.fn(async () => undefined);
vi.mock("./client", () => ({ appClient: () => ({ instanceSettings, request }) }));

describe("l'archiviazione, i percorsi veri", () => {
  it("lettura e salvataggio dal client.instanceSettings", async () => {
    const { liveStorageApiForTest: api } = await import("./storage");
    await api.get();
    await api.save({ contentLanguage: "en", s3Bucket: "b" });
    expect(instanceSettings.get).toHaveBeenCalled();
    expect(instanceSettings.save).toHaveBeenCalledWith({ contentLanguage: "en", s3Bucket: "b" });
  });

  // Lotto 6, voce 2 (72): l'interruttore degli allegati ha la sua rotta.
  it("l'interruttore degli allegati: PUT /api/settings/instance/attachments", async () => {
    const { liveStorageApiForTest: api } = await import("./storage");
    await api.setAttachments(false);
    expect(request).toHaveBeenCalledWith("PUT", "/api/settings/instance/attachments", {
      on: false,
    });
  });
});
