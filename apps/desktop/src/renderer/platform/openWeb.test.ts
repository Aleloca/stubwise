import { afterEach, describe, expect, it, vi } from "vitest";
import { openInWeb } from "./openWeb";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { stubwise?: unknown }).stubwise;
});

describe("Open in web", () => {
  it("un URL esterno (una PR) si apre nel browser, mai come percorso dell'istanza", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const openWeb = vi.fn();
    window.stubwise = { platform: "darwin", openWeb };
    openInWeb("https://github.com/acme/app/pull/7");
    expect(open).toHaveBeenCalledWith("https://github.com/acme/app/pull/7", "_blank", "noopener,noreferrer");
    expect(openWeb).not.toHaveBeenCalled();
  });

  it("un percorso dell'istanza sul desktop passa da open:web", () => {
    const openWeb = vi.fn(async () => ({ ok: true }));
    window.stubwise = { platform: "darwin", openWeb };
    openInWeb("/tickets/1");
    expect(openWeb).toHaveBeenCalledWith("/tickets/1");
  });

  it("uno schema che non è http(s) non si apre", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    openInWeb("javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
  });
});
