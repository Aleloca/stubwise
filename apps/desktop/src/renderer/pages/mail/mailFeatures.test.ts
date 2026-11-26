import { afterEach, describe, expect, it, vi } from "vitest";

import { openOnGoogle } from "./mailFeatures";

// Review F5a (5): l'app apre fuori solo Gmail e Google Docs, qualunque link arrivi.
describe("openOnGoogle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Gmail e un Google Doc si aprono", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    openOnGoogle("https://mail.google.com/mail/u/0/#all/abc");
    openOnGoogle("https://docs.google.com/document/d/abc");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("un altro host no (anche uno che lo imita)", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    openOnGoogle("https://evil.test/document/d/abc");
    openOnGoogle("https://docs.google.com.evil.test/document/d/abc");
    openOnGoogle("javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
  });
});
