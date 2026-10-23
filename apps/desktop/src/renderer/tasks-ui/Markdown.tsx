import type { ReactNode } from "react";

// Markdown in sola lettura per descrizioni e commenti: il sottoinsieme che si
// scrive davvero in una task (paragrafi, titoletti, elenchi, grassetto,
// corsivo, codice in linea, link). Costruisce elementi React, mai HTML
// grezzo: un testo dell'utente non può iniettare markup.

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

const UL = /^\s*[-*]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const H = /^#{1,6}\s+(.*)$/;

function blocks(source: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
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

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function inline(text: string, key: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    const k = `${key}-${i}`;
    if (!part) return null;
    if (/^(\*\*|__).+\1$/.test(part)) {
      return (
        <strong key={k} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (/^`.+`$/.test(part)) {
      // Codice in linea: nessun monospace nel prodotto, un fondo tenue lo distingue.
      return (
        <code key={k} className="rounded-[4px] bg-ink/8 px-1 py-px font-sans text-[0.95em]">
          {part.slice(1, -1)}
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
    if (/^([*_]).+\1$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Un testo markdown, nel corpo del pannello (14 px, misura stretta del pannello). */
export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 text-md text-ink [overflow-wrap:anywhere] ${className}`}>
      {blocks(source).map((block, i) => {
        const key = String(i);
        switch (block.kind) {
          case "h":
            return (
              <p key={key} className="pt-1 font-semibold text-ink">
                {inline(block.text, key)}
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
                  <li key={j}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </List>
            );
          }
          default:
            return (
              <p key={key} className="whitespace-pre-line">
                {inline(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
