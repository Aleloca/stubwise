import { Fragment, type ReactNode } from "react";

// Markdown in sola lettura per descrizioni, commenti e i messaggi di Claude:
// il sottoinsieme che si scrive davvero (paragrafi, titoletti, elenchi,
// grassetto, corsivo, codice in linea, link) più blocchi di codice e
// tabelle, che servono al flusso di Claude. Costruisce elementi React, mai
// HTML grezzo: un testo dell'utente non può iniettare markup.
//
// Un blocco di codice o una tabella larghi scorrono in orizzontale DENTRO
// il blocco (che prende il fuoco e si può scorrere da tastiera): la pagina
// non si allarga mai.

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

const UL = /^\s*[-*]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const H = /^#{1,6}\s+(.*)$/;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function blocks(source: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      // Un blocco di codice: fino alla chiusura (o alla fine, mentre arriva).
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE.test(lines[j]!)) body.push(lines[j++]!);
      out.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      i = j;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) rows.push(cells(lines[j++]!));
      out.push({ kind: "table", header, rows });
      i = j - 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = H.exec(line);
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (h) {
      flush();
      out.push({ kind: "h", text: h[1]! });
    } else if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const item = (ul ?? ol)![1]!;
      const last = out.at(-1);
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

/** Cambia il testo semplice di un messaggio (es. i codici citati che diventano link). */
export type TextDecorator = (text: string, key: string) => ReactNode;

/**
 * Un percorso (`src/import/match.ts`) che può andare a capo dopo ogni «/»,
 * nel monospace di sistema del flusso, con il percorso intero al passaggio.
 */
export function BreakablePath({ path, className = "" }: { path: string; className?: string }) {
  const parts = path.split("/");
  return (
    <span title={path} className={`font-code ${className}`}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  );
}

const PATH = /^[\w.@-]+(\/[\w.@-]+)+\/?$/;

function inline(text: string, key: string, decorate?: TextDecorator): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    const k = `${key}-${i}`;
    if (!part) return null;
    if (/^(\*\*|__).+\1$/.test(part)) {
      return (
        <strong key={k} className="font-semibold text-ink">
          {inline(part.slice(2, -2), k, decorate)}
        </strong>
      );
    }
    if (/^`.+`$/.test(part)) {
      const body = part.slice(1, -1);
      // Un percorso nel flusso: monospace di sistema, a capo dopo ogni «/».
      if (decorate && PATH.test(body)) {
        return (
          <code key={k} className="rounded-[4px] bg-ink/8 px-1 py-px">
            <BreakablePath path={body} />
          </code>
        );
      }
      // Codice in linea: nessun monospace nel prodotto, un fondo tenue lo distingue.
      return (
        <code key={k} className="rounded-[4px] bg-ink/8 px-1 py-px font-sans text-[0.95em]">
          {body}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]!);
      return href ? (
        <a
          key={k}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-ink underline decoration-ink/40 hover:decoration-ink"
        >
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    if (/^([*_]).+\1$/.test(part)) {
      return <em key={k}>{inline(part.slice(1, -1), k, decorate)}</em>;
    }
    return decorate ? <Fragment key={k}>{decorate(part, k)}</Fragment> : part;
  });
}

/**
 * Un testo markdown, nel corpo del pannello o nel flusso di Claude (14 px).
 * `decorate` cambia il testo semplice (fuori da codice e link): il flusso lo
 * usa per rendere apribili i codici citati.
 */
export function Markdown({
  source,
  className = "",
  decorate,
  codeLabel = "Code",
  tableLabel = "Table",
  trailing,
}: {
  source: string;
  className?: string;
  decorate?: TextDecorator;
  /** Il nome accessibile di un blocco di codice (che si scorre da tastiera). */
  codeLabel?: string;
  /** Il nome accessibile del contenitore di una tabella (che si scorre da tastiera). */
  tableLabel?: string;
  /** In coda all'ultimo blocco di testo (il cursore di un messaggio che arriva). */
  trailing?: ReactNode;
}) {
  const list = blocks(source);
  const last = list.length - 1;
  const tail = (i: number) => (i === last ? trailing : null);
  // Dopo un blocco di codice o una tabella (o senza testo) il cursore va a capo.
  const trailingAlone = last < 0 || list[last]!.kind === "code" || list[last]!.kind === "table";
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 text-md text-ink [overflow-wrap:anywhere] ${className}`}
    >
      {list.map((block, i) => {
        const key = String(i);
        switch (block.kind) {
          case "h":
            return (
              <p key={key} className="pt-1 font-semibold text-ink">
                {inline(block.text, key, decorate)}
                {tail(i)}
              </p>
            );
          case "ul":
          case "ol": {
            const List = block.kind;
            return (
              <List
                key={key}
                className={`flex flex-col gap-1 pl-5 ${block.kind === "ul" ? "list-disc" : "list-decimal"} marker:text-ink-faint`}
              >
                {block.items.map((item, j) => (
                  <li key={j}>
                    {inline(item, `${key}-${j}`, decorate)}
                    {j === block.items.length - 1 && tail(i)}
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre
                key={key}
                data-code-block
                tabIndex={0}
                aria-label={block.lang ? `${codeLabel} · ${block.lang}` : codeLabel}
                className="font-code max-w-full min-w-0 overflow-x-auto rounded-md bg-ink/5 px-3 py-2.5 whitespace-pre text-ink [overflow-wrap:normal]"
              >
                <code className="font-code">{block.text}</code>
              </pre>
            );
          case "table":
            return (
              <div
                key={key}
                data-table-scroll
                role="region"
                aria-label={tableLabel}
                tabIndex={0}
                className="max-w-full min-w-0 overflow-x-auto"
              >
                <table className="num w-full border-collapse text-sm [overflow-wrap:normal]">
                  <thead>
                    <tr className="border-b border-rule-strong">
                      {block.header.map((cell, j) => (
                        <th
                          key={j}
                          scope="col"
                          className="px-2 py-1.5 text-left font-semibold whitespace-nowrap text-ink first:pl-0"
                        >
                          {inline(cell, `${key}-h${j}`, decorate)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-rule">
                        {block.header.map((_, j) => (
                          <td key={j} className="px-2 py-1.5 align-top text-ink first:pl-0">
                            {inline(row[j] ?? "", `${key}-${r}-${j}`, decorate)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-line">
                {inline(block.text, key, decorate)}
                {tail(i)}
              </p>
            );
        }
      })}
      {trailingAlone && trailing}
    </div>
  );
}
