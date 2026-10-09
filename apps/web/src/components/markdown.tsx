import { marked } from "marked";
import { useMemo } from "react";
import sanitizeHtml from "sanitize-html";

/**
 * Allowlist per il markdown renderizzato: i tag che marked produce (GFM
 * compreso) più le immagini. Script, attributi-evento e URL `javascript:`
 * non passano. sanitize-html lavora sul parser (htmlparser2), non sul DOM:
 * si comporta allo stesso modo nel browser e in happy-dom nei test —
 * DOMPurify invece si appoggia al DOM dell'ambiente e happy-dom lo rompe.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "del", "ins"],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    // La classe del linguaggio sui blocchi di codice (es. language-ts).
    code: ["class"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
};

/**
 * Markdown renderizzato e sanitizzato. La sorgente può arrivare da utenti,
 * SDK o dall'AI: mai fidarsi. Lo stile vive nella classe `.markdown` globale.
 */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true, breaks: true });
    return sanitizeHtml(raw, SANITIZE_OPTIONS);
  }, [source]);

  // dangerouslySetInnerHTML è sicuro qui: l'HTML è sanitizzato qui sopra.
  return <div className="markdown text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Solo formattazione di testo: niente link (un `<a>` dentro un radio sarebbe un interattivo annidato), niente blocchi. */
const INLINE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["code", "em", "strong", "del"],
  allowedAttributes: {},
};

/**
 * Markdown INLINE (`marked.parseInline`, stessa pipeline e stesso sanitizer di
 * `Markdown`, allowlist ridotta): per testi che stanno dentro un controllo —
 * etichette e conseguenze delle opzioni di una domanda. Uno `span`, nessun
 * margine di blocco; un link diventa il suo testo; il nome accessibile
 * resta il testo senza i segni del markdown.
 */
export function InlineMarkdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parseInline(source, { async: false, gfm: true, breaks: false });
    return sanitizeHtml(raw, INLINE_SANITIZE_OPTIONS);
  }, [source]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
