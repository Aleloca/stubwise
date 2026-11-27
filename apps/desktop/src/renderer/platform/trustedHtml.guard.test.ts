import { describe, expect, it } from "vitest";

// Trusted Types (revisione I-4): nel renderer l'HTML si scrive SOLO dalla
// politica `stubwise-html` (`platform/trustedHtml.tsx`). Una guardia sul
// sorgente, commenti esclusi.

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALLOWED = "./trustedHtml.tsx";
/** Le SCRITTURE di HTML (una lettura di `innerHTML` non è un punto d'iniezione). */
const SINKS =
  /\bdangerouslySetInnerHTML\b|\.\s*(innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bsrcDoc\b|\bsrcdoc\b|\bparseFromString\s*\(|\bcreateContextualFragment\s*\(|\bdocument\s*\.\s*write(ln)?\s*\(/;

const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function sinksIn(source: string): boolean {
  return SINKS.test(codeOnly(source));
}

describe("l'HTML si scrive solo dalla politica", () => {
  it("trova i sorgenti del renderer", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(SOURCES)).toContain(ALLOWED);
  });

  it("nessun punto d'iniezione fuori da platform/trustedHtml.tsx", () => {
    const found = Object.entries(SOURCES)
      .filter(([path, source]) => path !== ALLOWED && sinksIn(source))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it("il controllo vede il codice e ignora i commenti", () => {
    expect(sinksIn('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
    expect(sinksIn("el.innerHTML = s;")).toBe(true);
    expect(sinksIn("document.write(s);")).toBe(true);
    expect(sinksIn('new DOMParser().parseFromString(s, "text/html");')).toBe(true);
    expect(sinksIn("<iframe srcDoc={doc} />")).toBe(true);
    // Una lettura non è una scrittura.
    expect(sinksIn("const parts = blocks(cell.innerHTML);")).toBe(false);
    expect(sinksIn("if (a.outerHTML !== b.outerHTML) {}")).toBe(false);
    expect(sinksIn("// niente dangerouslySetInnerHTML qui\nconst a = 1;")).toBe(false);
  });

  it("chi importa cosa: schizzi, parsing e cornice della posta solo dai loro moduli", () => {
    const ALLOWED_IMPORTERS: Record<string, string[]> = {
      TrustedSvg: ["../pages/productDocs/editor/WireframeBlock.tsx", "../pages/productDocs/export/PrintView.tsx"],
      trustedSketchHtml: [],
      parseInertHtml: ["../pages/mail/mailHtml.ts", "../domain/productDocs/pasteHtml.ts"],
      TrustedMailFrame: ["../pages/mail/UntrustedHtmlFrame.tsx"],
    };
    const wrong: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path === ALLOWED) continue;
      const m = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*platform\/trustedHtml["']/.exec(source);
      if (!m) continue;
      for (const name of m[1]!.split(",").map((n) => n.trim()).filter(Boolean)) {
        if (!(ALLOWED_IMPORTERS[name] ?? []).includes(path)) wrong.push(`${path}: ${name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("nessun altro modulo crea politiche: createPolicy solo qui e nel boot della cassaforte", () => {
    const POLICY_HOMES = [ALLOWED, "../data/backend/real/vaultBrowser/primitives.ts"];
    const found = Object.entries(SOURCES)
      .filter(([path, source]) => !POLICY_HOMES.includes(path) && /\bcreatePolicy\b/.test(codeOnly(source)))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });
});

