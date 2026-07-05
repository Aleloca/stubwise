import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConversationId,
  getConversationId,
  setConversationId,
} from "./storage.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("conversation storage", () => {
  it("ritorna null quando non c'è nulla salvato", () => {
    expect(getConversationId("acme")).toBeNull();
  });

  it("persiste e rilegge l'id per slug", () => {
    setConversationId("acme", "conv-1");
    expect(getConversationId("acme")).toBe("conv-1");
    expect(localStorage.getItem("stubwise-widget:acme:conversation")).toBe("conv-1");
  });

  it("isola gli slug tra loro", () => {
    setConversationId("acme", "conv-a");
    setConversationId("globex", "conv-b");
    expect(getConversationId("acme")).toBe("conv-a");
    expect(getConversationId("globex")).toBe("conv-b");
  });

  it("clear rimuove l'id salvato", () => {
    setConversationId("acme", "conv-1");
    clearConversationId("acme");
    expect(getConversationId("acme")).toBeNull();
  });

  it("getter ritorna null se localStorage lancia (privacy mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getConversationId("acme")).toBeNull();
  });

  it("setter è no-op se localStorage lancia (privacy mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setConversationId("acme", "conv-1")).not.toThrow();
  });

  it("clear è no-op se localStorage lancia (privacy mode)", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => clearConversationId("acme")).not.toThrow();
  });
});
