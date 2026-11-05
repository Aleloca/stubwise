import { createPortal } from "react-dom";
import {
  blockHeadingLevel,
  pageHeadingLevel,
  type ExportBlock,
  type ExportDoc,
  type ExportRun,
} from "../../../domain/productDocs/exportModel";

// La vista di stampa del PDF (area 11a, Task 12): disegna lo stesso
// `ExportDoc` del Word — `<strong>`, `<em>`, `<a>` dagli `ExportRun` — in
// `#print-root`, fuori dall'app. Si monta solo durante l'esportazione; con
// `body[data-printing]` la stampa mostra lei sola (`styles/index.css`).

/** Il contenitore della stampa: quello di `index.html`, o creato al volo (test, finestre senza). */
export function printRoot(): HTMLElement {
  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.append(root);
  }
  return root;
}

function Runs({ runs }: { runs: ExportRun[] }) {
  return runs.map((r, i) => {
    let node: React.ReactNode = r.text;
    if (r.italic) node = <em>{node}</em>;
    if (r.bold) node = <strong>{node}</strong>;
    if (r.href) node = <a href={r.href}>{node}</a>;
    return <span key={i}>{node}</span>;
  });
}

type Heading = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
/** Il titolo del documento è l'h1; il livello n del modello è un h(n+1). */
const tagOf = (level: number): Heading => `h${Math.min(level + 1, 6)}` as Heading;

/** I blocchi di una pagina; le voci di un elenco vicine stanno in un solo `<ul>`/`<ol>`. */
function Blocks({ doc, depth, blocks }: { doc: ExportDoc; depth: number; blocks: ExportBlock[] }) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "list") {
      const items: Extract<ExportBlock, { kind: "list" }>[] = [];
      while (i < blocks.length) {
        const next = blocks[i]!;
        if (next.kind !== "list" || next.ordered !== b.ordered) break;
        items.push(next);
        i++;
      }
      i--;
      const List = b.ordered ? "ol" : "ul";
      out.push(
        <List key={i}>
          {items.map((item, j) => (
            <li key={j} style={{ marginLeft: `${item.indent * 18}pt` }}>
              <Runs runs={item.runs} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (b.kind === "todo") {
      const items: Extract<ExportBlock, { kind: "todo" }>[] = [];
      while (i < blocks.length && blocks[i]!.kind === "todo") items.push(blocks[i++] as (typeof items)[number]);
      i--;
      out.push(
        <ul key={i} className="print-todo">
          {items.map((item, j) => (
            <li key={j}>
              <input type="checkbox" checked={item.checked} readOnly disabled /> <Runs runs={item.runs} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    out.push(<Block key={i} doc={doc} depth={depth} block={b} />);
  }
  return out;
}

function Block({ doc, depth, block: b }: { doc: ExportDoc; depth: number; block: ExportBlock }) {
  switch (b.kind) {
    case "heading": {
      const H = tagOf(blockHeadingLevel(doc, depth, b.level));
      return (
        <H>
          <Runs runs={b.runs} />
        </H>
      );
    }
    case "paragraph":
      return (
        <p>
          <Runs runs={b.runs} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <Runs runs={b.runs} />
        </blockquote>
      );
    case "divider":
      return <hr />;
    case "table":
      return (
        <table>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>
                    <Runs runs={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "image":
      return (
        <figure>
          <img src={b.src} alt={b.caption} />
          {b.caption.trim() !== "" && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
    case "line":
      return <p>{b.line}</p>;
    case "list":
    case "todo":
      return null;
  }
}

export function PrintView({ doc, label }: { doc: ExportDoc; label: string }) {
  return createPortal(
    <article className="print-view" aria-label={label}>
      <h1>{doc.title}</h1>
      {doc.pages.map((page) => {
        const level = pageHeadingLevel(doc, page.depth);
        const H = level === null ? null : tagOf(level);
        return (
          <section key={page.code} className="print-page">
            {H && <H>{page.title}</H>}
            <p className="print-code">{page.code}</p>
            <Blocks doc={doc} depth={page.depth} blocks={page.blocks} />
          </section>
        );
      })}
    </article>,
    printRoot(),
  );
}
