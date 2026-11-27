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

/**
 * m-6: i nodi di `parseInertHtml` non escono dal modulo che li legge. Nel
 * sorgente: niente che li adotti o li inserisca nel documento VIVO, e ogni
 * funzione esportata dichiara un tipo di ritorno che non è un nodo.
 * (`ownerDocument` di un nodo inerte è il documento inerte: leggerlo, per
 * esempio con un `TreeWalker`, non porta niente nella pagina.)
 */
const LIVE_DOM =
  /\b(importNode|adoptNode|replaceChildren|insertAdjacentElement)\b|\b(document|window|globalThis|self|parent|top)\b/;
const DOM_TYPE = /\b(Node|Element|HTMLElement|SVGElement|Document|DocumentFragment|ChildNode|ParentNode|NodeList|HTMLCollection)\b/;

export function inertLeaks(source: string): string[] {
  const code = codeOnly(source);
  const out: string[] = [];
  const live = LIVE_DOM.exec(code);
  if (live) out.push(`il documento vivo: ${live[0]}`);
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(:\s*([^{]+))?\{/g)) {
    const [, name, , typed, type] = m;
    if (!typed) out.push(`${name}: senza tipo di ritorno`);
    else if (DOM_TYPE.test(type!)) out.push(`${name}: restituisce un nodo (${type!.trim()})`);
  }
  if (/export\s+(const|let|var)\s/.test(code)) out.push("un export che non è una funzione");
  return out;
}

const INERT_READERS = ["../pages/mail/mailHtml.ts", "../domain/productDocs/pasteHtml.ts"];

describe("m-6: i nodi del documento inerte restano dentro chi lo legge", () => {
  it("i due moduli che importano `parseInertHtml` non toccano il documento vivo e non restituiscono nodi", () => {
    const found = INERT_READERS.flatMap((path) => {
      expect(SOURCES[path], path).toBeDefined();
      return inertLeaks(SOURCES[path]!).map((w) => `${path}: ${w}`);
    });
    expect(found).toEqual([]);
  });

  it("il controllo scatta su ciò che deve fermare", () => {
    expect(inertLeaks("export function f(h: string): string { return h; }")).toEqual([]);
    expect(inertLeaks("export function f(h: string): HTMLElement { return x; }")).toEqual(["f: restituisce un nodo (HTMLElement)"]);
    expect(inertLeaks("export function f(h: string) { return x; }")).toEqual(["f: senza tipo di ritorno"]);
    expect(inertLeaks("function g() { document.body.append(n); }")).toEqual(["il documento vivo: document"]);
    expect(inertLeaks("function g(live: Node) { live.importNode(n); }")).toEqual(["il documento vivo: importNode"]);
    expect(inertLeaks("export const body = parsed.body;")).toEqual(["un export che non è una funzione"]);
    expect(inertLeaks("// document.adoptNode(x)\nexport function f(): number { return 1; }")).toEqual([]);
  });
});

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

