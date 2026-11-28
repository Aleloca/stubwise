import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Trusted Types sulla nuova app (revisione I-4): l'unico punto che scrive
// HTML è la politica `stubwise-html`, e il suo `createHTML` accetta SOLO
// l'uscita del nostro sanitizzatore degli schizzi.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const SKETCH = '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8"></rect></svg>';

describe("la politica stubwise-html", () => {
  it("con i Trusted Types: la politica nasce una volta, e createHTML passa solo un SVG già ripulito", async () => {
    const created: string[] = [];
    vi.stubGlobal("trustedTypes", {
      createPolicy: (name: string, rules: { createHTML: (s: string) => string }) => {
        created.push(name);
        return {
          createHTML: (s: string) => {
            const v = rules.createHTML(s);
            return { toString: () => v };
          },
        };
      },
    });
    const { trustedSketchHtml } = await import("./trustedHtml");
    const { sanitizeWireframeSvg } = await import("@stubwise/shared");
    const clean = sanitizeWireframeSvg(SKETCH)!;
    expect(String(trustedSketchHtml(clean))).toBe(clean);
    expect(() => trustedSketchHtml('<svg><script>alert(1)</script></svg>')).toThrow("stubwise_html_refused");
    trustedSketchHtml(clean);
    expect(created).toEqual(["stubwise-html"]);
  });

  it("TrustedSvg scrive lo schizzo ripulito nel nodo, e uno SVG che non regge non scrive niente", async () => {
    const { TrustedSvg } = await import("./trustedHtml");
    const { sanitizeWireframeSvg } = await import("@stubwise/shared");
    const clean = sanitizeWireframeSvg(SKETCH)!;
    const { container } = render(<TrustedSvg svg={clean} role="img" aria-label="x" />);
    expect(container.querySelector("[role=img] svg rect")).not.toBeNull();
    const bad = render(<TrustedSvg svg={'<svg onload="x()"></svg>'} role="img" aria-label="y" />);
    expect(bad.container.querySelector("svg")).toBeNull();
  });

  it("parseInertHtml: un documento inerte (uno script non gira)", async () => {
    const { parseInertHtml } = await import("./trustedHtml");
    const doc = parseInertHtml('<p>ciao</p><script>window.__ran = true</script>');
    expect(doc.body.querySelector("p")?.textContent).toBe("ciao");
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
  });

  it("TrustedMailFrame: nel srcdoc solo l'HTML bonificato (niente script né gestori)", async () => {
    const { TrustedMailFrame } = await import("./trustedHtml");
    const { container } = render(
      <TrustedMailFrame html={'<p onclick="x()">ciao</p><script>evil()</script>'} loaded={null} title="m" sandbox="" />,
    );
    const doc = container.querySelector("iframe")!.getAttribute("srcdoc") ?? (container.querySelector("iframe") as HTMLIFrameElement).srcdoc;
    expect(doc).toContain("<p>ciao</p>");
    expect(doc).not.toContain("<script>evil");
    expect(doc).not.toContain("onclick");
  });
});

