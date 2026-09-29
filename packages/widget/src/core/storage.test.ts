import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConversationId,
  getConversationId,
  getPosition,
  setConversationId,
  setPosition,
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

describe("bubble position storage", () => {
  it("null quando non c'è nulla salvato", () => {
    expect(getPosition("acme")).toBeNull();
  });

  it("persiste e rilegge per slug, come JSON sotto la chiave dedicata", () => {
    setPosition("acme", { side: "left", y: 0.4 });
    expect(getPosition("acme")).toEqual({ side: "left", y: 0.4 });
    expect(JSON.parse(localStorage.getItem("stubwise-widget:acme:position")!)).toEqual({
      side: "left",
      y: 0.4,
    });
    expect(getPosition("globex")).toBeNull();
  });

  it.each([
    ["non JSON", "{nope"],
    ["lato sconosciuto", JSON.stringify({ side: "top", y: 0.5 })],
    ["y fuori range", JSON.stringify({ side: "left", y: 1.5 })],
    ["y negativa", JSON.stringify({ side: "left", y: -0.1 })],
    ["y non numerica", JSON.stringify({ side: "left", y: "0.5" })],
    ["null", "null"],
  ])("valore corrotto (%s) → null", (_label, raw) => {
    localStorage.setItem("stubwise-widget:acme:position", raw);
    expect(getPosition("acme")).toBeNull();
  });

  it("getter null e setter no-op se localStorage lancia", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getPosition("acme")).toBeNull();
    expect(() => setPosition("acme", { side: "right", y: 1 })).not.toThrow();
  });
});
