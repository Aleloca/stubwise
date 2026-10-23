// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isExternalOpenAllowed, isNavigationAllowed, PRODUCTION_CSP } from "./security";

const packagedUrl = "file:///Applications/Stubwise.app/out/renderer/index.html";

describe("isNavigationAllowed", () => {
  it("in dev ammette solo l'origine del dev server", () => {
    const o = { devUrl: "http://localhost:5173", packagedUrl };
    expect(isNavigationAllowed("http://localhost:5173/#/home", o)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5174/", o)).toBe(false);
    expect(isNavigationAllowed("https://example.com/", o)).toBe(false);
    expect(isNavigationAllowed(packagedUrl, o)).toBe(false);
  });
  it("impacchettato ammette solo lo stesso file (l'hash cambia)", () => {
    expect(isNavigationAllowed(`${packagedUrl}#/p/STW`, { packagedUrl })).toBe(true);
    expect(isNavigationAllowed("file:///etc/passwd", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("https://example.com/", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("javascript:alert(1)", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("non un url", { packagedUrl })).toBe(false);
  });
});

describe("isExternalOpenAllowed", () => {
  it("lascia uscire solo http(s)", () => {
    expect(isExternalOpenAllowed("https://stubwise.dev")).toBe(true);
    expect(isExternalOpenAllowed("http://example.com")).toBe(true);
    expect(isExternalOpenAllowed("file:///etc/passwd")).toBe(false);
    expect(isExternalOpenAllowed("smb://host/share")).toBe(false);
    expect(isExternalOpenAllowed("nonsense")).toBe(false);
  });
});

describe("PRODUCTION_CSP", () => {
  it("vieta oggetti e base, e non ammette script inline né eval", () => {
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("base-uri 'none'");
    expect(PRODUCTION_CSP).toMatch(/script-src 'self'(;|$)/);
    expect(PRODUCTION_CSP).not.toContain("unsafe-eval");
  });
});
