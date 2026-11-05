import type { ReactNode } from "react";
import { CodeLink } from "../../../components/CodeLink";
import type { RichText } from "../../../data/types";
import { richSegments, safeLinkHref, type RichSegment } from "../../../domain/productDocs/richText";

// Una frase coi suoi segni (shape product-editor.md §3.2): grassetto
// `<strong>` 600, corsivo `<em>`, link sottolineato `ink` (1 px, offset 2;
// al passaggio 2 px), i codici `CodeLink`. Due forme con lo STESSO DOM (uno
// span per pezzo di `richSegments`), così `offsetOf`/`placeCaret` leggono
// l'una e l'altra:
// - `RichView` (React), per chi legge e per i blocchi fuori dal fuoco: i
//   link si aprono col browser di sistema (`target="_blank"` →
//   `setWindowOpenHandler`), i codici sono `CodeLink`;
// - `paintRich`, per il blocco col fuoco: il blocco ridisegna da sé il suo
//   `contenteditable` a ogni cambio, e un nodo estraneo (un'estensione, il
//   correttore) se ne va. Lì un codice resta 600 tnum ma non è un link: un
//   clic mette il cursore, non naviga.
// Un `href` passa di nuovo da `safeLinkHref` anche qui: il dato lo
// garantisce già, il DOM non lo dà per scontato.

export const linkClass =
  "text-ink underline decoration-1 underline-offset-2 hover:decoration-2";
const codeClass = "num font-semibold";

/** L'a capo in coda non si vedrebbe: un `<br>` lo rende (e non è una lettera). */
const endsWithBreak = (content: RichText) => content.text.endsWith("\n");

function segmentNode(s: RichSegment, links: boolean, key: number): ReactNode {
  let node: ReactNode = s.code ? (
    links ? (
      <CodeLink code={s.code} />
    ) : (
      <span className={codeClass}>{s.code}</span>
    )
  ) : (
    s.text
  );
  if (s.bold) node = <strong className="font-semibold">{node}</strong>;
  if (s.italic) node = <em>{node}</em>;
  const href = s.href ? safeLinkHref(s.href) : null;
  if (href && !s.code)
    node = links ? (
      <a href={href} target="_blank" rel="noreferrer" title={href} className={linkClass}>
        {node}
      </a>
    ) : (
      <a href={href} title={href} className={linkClass}>
        {node}
      </a>
    );
  return <span key={key}>{node}</span>;
}

/** La frase da leggere: codici `CodeLink` e link che si aprono (`links`), o in tutto testo. */
export function RichView({ content, links = true }: { content: RichText; links?: boolean }) {
  return (
    <>
      {richSegments(content).map((s, i) => segmentNode(s, links, i))}
      {endsWithBreak(content) && <br data-rich-trail="" />}
    </>
  );
}

/**
 * Ridisegna `root` dalla frase: lo stesso DOM di `RichView` senza link
 * apribili né `CodeLink`. Tutto ciò che c'era dentro se ne va.
 */
export function paintRich(root: HTMLElement, content: RichText): void {
  const doc = root.ownerDocument;
  const nodes: Node[] = richSegments(content).map((s) => {
    let node: Node = doc.createTextNode(s.code ?? s.text);
    if (s.code) {
      const code = doc.createElement("span");
      code.className = codeClass;
      code.append(node);
      node = code;
    }
    if (s.bold) {
      const strong = doc.createElement("strong");
      strong.className = "font-semibold";
      strong.append(node);
      node = strong;
    }
    if (s.italic) {
      const em = doc.createElement("em");
      em.append(node);
      node = em;
    }
    const href = s.href ? safeLinkHref(s.href) : null;
    if (href && !s.code) {
      const a = doc.createElement("a");
      a.href = href;
      a.title = href;
      a.className = linkClass;
      a.append(node);
      node = a;
    }
    const span = doc.createElement("span");
    span.append(node);
    return span;
  });
  if (endsWithBreak(content)) {
    const br = doc.createElement("br");
    br.setAttribute("data-rich-trail", "");
    nodes.push(br);
  }
  root.replaceChildren(...nodes);
}
