/**
 * Mini renderer markdown → nodi Preact. Le risposte dell'assistente arrivano in
 * markdown: qui ne parsiamo un SOTTOINSIEME e produciamo direttamente nodi
 * Preact. La sicurezza XSS deriva dal non toccare MAI l'HTML (nessun innerHTML /
 * dangerouslySetInnerHTML): ogni pezzo di testo dell'utente diventa un text node,
 * quindi eventuale HTML nel testo appare come testo letterale, non interpretato.
 *
 * Supportato: paragrafi (righe vuote), line break singoli, `**bold**`,
 * `*italic*`/`_italic_`, `` `inline code` ``, blocchi ``` (→ <pre><code>),
 * liste puntate (`- `/`* `) e numerate (`1. `), heading `#`–`###` (→ paragrafo
 * in grassetto, niente h1 giganti nel widget), link `[testo](url)` SOLO con
 * protocollo http/https (altri → testo semplice). Tutto il resto passa come testo.
 *
 * Parser a mano, compatto, nessuna dipendenza: l'obiettivo è tenere piccolo il
 * bundle IIFE embeddabile.
 */
import type { ComponentChildren, VNode } from "preact";

/** Un blocco di alto livello riconosciuto nel testo. */
type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

const HEADING = /^#{1,3}\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;

/** Spezza il testo in blocchi (code fence, heading, liste, paragrafi). */
function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code fence ```: cattura fino alla chiusura (o fine testo se manca).
    if (/^```/.test(line.trim())) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i += 1;
      }
      // Salta la fence di chiusura se presente.
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    // Riga vuota: separatore di paragrafi, nessun blocco.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Heading.
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", text: h[1]! });
      i += 1;
      continue;
    }

    // Lista puntata: righe consecutive `- `/`* `.
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i]!)) {
        items.push(BULLET.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Lista numerata: righe consecutive `N. `.
    if (ORDERED.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED.test(lines[i]!)) {
        items.push(ORDERED.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragrafo: righe consecutive fino a una riga vuota o a un altro blocco.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!.trim()) &&
      !HEADING.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !ORDERED.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "p", lines: para });
  }

  return blocks;
}

/**
 * Rende l'inline markdown di una singola riga in nodi Preact: `**bold**`,
 * `*italic*`/`_italic_`, `` `code` ``, link `[t](http...)`. Scanner a singolo
 * passaggio: a ogni posizione tenta i marcatori; ciò che non matcha diventa
 * testo. Non riconoscendo mai HTML, il testo grezzo resta letterale.
 */
function renderInline(text: string): ComponentChildren {
  const out: ComponentChildren[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  let i = 0;
  let key = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code: `...` (ha la precedenza, nessun markdown dentro).
    if (rest[0] === "`") {
      const end = rest.indexOf("`", 1);
      if (end > 0) {
        flush();
        out.push(<code key={key++}>{rest.slice(1, end)}</code>);
        i += end + 1;
        continue;
      }
    }

    // Bold: **...** (prima di *italic*).
    if (rest.startsWith("**")) {
      const end = rest.indexOf("**", 2);
      if (end > 0) {
        flush();
        out.push(<strong key={key++}>{renderInline(rest.slice(2, end))}</strong>);
        i += end + 2;
        continue;
      }
    }

    // Italic: *...* o _..._ (marcatore singolo, non vuoto).
    if (rest[0] === "*" || rest[0] === "_") {
      const marker = rest[0];
      const end = rest.indexOf(marker, 1);
      if (end > 1) {
        flush();
        out.push(<em key={key++}>{renderInline(rest.slice(1, end))}</em>);
        i += end + 1;
        continue;
      }
    }

    // Link: [testo](url) SOLO http/https.
    if (rest[0] === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (m && /^https?:\/\//i.test(m[2]!)) {
        flush();
        out.push(
          <a key={key++} href={m[2]} target="_blank" rel="noopener noreferrer">
            {renderInline(m[1]!)}
          </a>,
        );
        i += m[0].length;
        continue;
      }
    }

    // Nessun marcatore: accumula il carattere come testo.
    buf += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** Rende le righe di un paragrafo con line break singoli (<br>) fra loro. */
function renderParagraphLines(lines: string[]): ComponentChildren {
  const out: ComponentChildren[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`br${idx}`} />);
    out.push(<span key={`ln${idx}`}>{renderInline(line)}</span>);
  });
  return out;
}

/** Rende un singolo blocco in un VNode Preact. */
function renderBlock(block: Block, key: number): VNode {
  switch (block.kind) {
    case "heading":
      return (
        <p key={key} class="sw-md-heading">
          <strong>{renderInline(block.text)}</strong>
        </p>
      );
    case "code":
      return (
        <pre key={key} class="sw-md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case "ul":
      return (
        <ul key={key} class="sw-md-list">
          {block.items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} class="sw-md-list">
          {block.items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "p":
    default:
      return (
        <p key={key} class="sw-md-p">
          {renderParagraphLines(block.lines)}
        </p>
      );
  }
}

/**
 * Parsa un sottoinsieme di markdown e ne restituisce i nodi Preact. Da usare
 * direttamente in JSX per i messaggi dell'assistente (anche durante lo streaming:
 * il testo accumulato si ri-renderizza a ogni delta).
 */
export function renderMarkdown(text: string): ComponentChildren {
  return toBlocks(text).map((b, i) => renderBlock(b, i));
}
