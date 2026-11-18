import { describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero degli account git (area 9, F3): passano dal client.

const gitAccounts = {
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  validate: vi.fn(async () => ({ ok: true, checks: [] })),
  setDefaultReviewer: vi.fn(async () => ({})),
  unsetDefaultReviewer: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
};
vi.mock("./client", () => ({ appClient: () => ({ gitAccounts }) }));

describe("gli account git, i percorsi veri", () => {
  it("elenco, crea, modifica, valida, revisore ed elimina dal client.gitAccounts", async () => {
    const { liveGitAccountsApiForTest: api } = await import("./gitAccounts");
    await api.list();
    await api.create({ name: "N", provider: "github", credentials: { token: "t" } });
    await api.update("g1", { name: "M" });
    await api.validate("g1");
    await api.setDefaultReviewer("g1");
    await api.unsetDefaultReviewer("g1");
    await api.remove("g1");
    expect(gitAccounts.create).toHaveBeenCalledWith({
      name: "N",
      provider: "github",
      credentials: { token: "t" },
    });
    expect(gitAccounts.update).toHaveBeenCalledWith("g1", { name: "M" });
    expect(gitAccounts.validate).toHaveBeenCalledWith("g1");
    expect(gitAccounts.setDefaultReviewer).toHaveBeenCalledWith("g1");
    expect(gitAccounts.unsetDefaultReviewer).toHaveBeenCalledWith("g1");
    expect(gitAccounts.remove).toHaveBeenCalledWith("g1");
  });
});
