import { afterEach, describe, expect, it, vi } from "vitest";
import { graphHtmlUrl } from "./graphFrame";

// L'HTML di graphify solo nella build web: nel Mac il renderer non ha il
// cookie della sessione, e resta il grafo delle comunità (come nel prototipo).

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("graphHtmlUrl", () => {
  it("nella build web la rotta del repository, con l'id codificato", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "web");
    expect(graphHtmlUrl("repo-stw")).toBe("/api/repositories/repo-stw/graph/html");
    expect(graphHtmlUrl("a/b")).toBe("/api/repositories/a%2Fb/graph/html");
  });

  it("nel Mac e nel prototipo niente iframe", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    // Il Mac: il target del build e, dove si guarda il ponte, il ponte del preload.
    vi.stubEnv("VITE_STUBWISE_TARGET", "electron");
    vi.stubGlobal("stubwise", { api: {}, vault: { create: () => undefined } });
    expect(graphHtmlUrl("repo-stw")).toBeNull();
    vi.stubEnv("VITE_STUBWISE_BUILD", "prototype");
    expect(graphHtmlUrl("repo-stw")).toBeNull();
  });
});
