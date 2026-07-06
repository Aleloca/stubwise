import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

/**
 * Il renderer produce nodi Preact (mai innerHTML): la sicurezza XSS deriva dal
 * non toccare mai l'HTML. Montiamo il risultato in un container e interroghiamo
 * il DOM reale (stesso pattern dei test UI del widget).
 */

let container: HTMLDivElement | null = null;

function mount(text: string): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  render(<div>{renderMarkdown(text)}</div>, container);
  return container.firstElementChild as HTMLDivElement;
}

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

describe("renderMarkdown inline", () => {
  it("bold **...** → <strong>", () => {
    const el = mount("ciao **mondo** ok");
    const strong = el.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("mondo");
    expect(el.textContent).toBe("ciao mondo ok");
  });

  it("italic *...* e _..._ → <em>", () => {
    expect(mount("un *corsivo* qui").querySelector("em")?.textContent).toBe("corsivo");
    expect(mount("un _corsivo_ qui").querySelector("em")?.textContent).toBe("corsivo");
  });

  it("inline code `...` → <code>", () => {
    const el = mount("usa `npm run` per");
    const code = el.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("npm run");
  });
});

describe("renderMarkdown blocks", () => {
  it("code block multiriga → <pre><code> col testo integrale", () => {
    const el = mount("prima\n```\nline1\nline2\n```\ndopo");
    const pre = el.querySelector("pre");
    expect(pre).not.toBeNull();
    const code = pre!.querySelector("code");
    expect(code!.textContent).toBe("line1\nline2");
  });

  it("dentro un code block il markdown NON viene interpretato", () => {
    const el = mount("```\n**non bold** `non code`\n```");
    expect(el.querySelector("pre strong")).toBeNull();
    expect(el.querySelector("pre")!.textContent).toContain("**non bold**");
  });

  it("lista puntata (- e *) → <ul><li>", () => {
    const dash = mount("- uno\n- due");
    expect(dash.querySelectorAll("ul li").length).toBe(2);
    expect(dash.querySelectorAll("ul li")[0]!.textContent).toBe("uno");
    const star = mount("* a\n* b");
    expect(star.querySelectorAll("ul li").length).toBe(2);
  });

  it("lista numerata (1. 2.) → <ol><li>", () => {
    const el = mount("1. primo\n2. secondo");
    expect(el.querySelectorAll("ol li").length).toBe(2);
    expect(el.querySelectorAll("ol li")[1]!.textContent).toBe("secondo");
  });

  it("heading #/##/### → paragrafo in grassetto (niente <h1>)", () => {
    const el = mount("# Titolo");
    expect(el.querySelector("h1")).toBeNull();
    expect(el.querySelector("h2")).toBeNull();
    expect(el.querySelector("strong")?.textContent).toBe("Titolo");
  });

  it("paragrafi separati da riga vuota → più blocchi", () => {
    const el = mount("primo paragrafo\n\nsecondo paragrafo");
    expect(el.textContent).toContain("primo paragrafo");
    expect(el.textContent).toContain("secondo paragrafo");
    // Due contenitori di paragrafo distinti.
    expect(el.querySelectorAll("p").length).toBe(2);
  });

  it("line break singolo dentro un paragrafo → <br>", () => {
    const el = mount("riga uno\nriga due");
    expect(el.querySelector("br")).not.toBeNull();
  });
});

describe("renderMarkdown links & security", () => {
  it("link http/https → <a> con target e rel", () => {
    const el = mount("vedi [qui](https://example.com/x) ora");
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/x");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a!.textContent).toBe("qui");
  });

  it("link con protocollo non http (javascript:) → NON diventa <a>, resta testo", () => {
    const el = mount("[click](javascript:alert(1))");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("click");
  });

  it("HTML letterale nel testo → appare come TESTO, nessun elemento creato", () => {
    const el = mount('prima <img onerror="alert(1)" src=x> dopo');
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain('<img onerror="alert(1)" src=x>');
  });
});

describe("renderMarkdown robustezza", () => {
  it("markdown malformato/spezzato non lancia", () => {
    expect(() => mount("**non chiuso e `code aperto e [link](http")).not.toThrow();
    expect(() => mount("")).not.toThrow();
    expect(() => mount("```\nsenza chiusura")).not.toThrow();
    expect(() => mount("*")).not.toThrow();
  });

  it("testo semplice passa invariato", () => {
    expect(mount("solo del testo normale").textContent).toBe("solo del testo normale");
  });
});
