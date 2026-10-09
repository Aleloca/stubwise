import { Marked, marked } from "marked";
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
 * Un'immagine diventa il suo `alt`, come TESTO (sanitize-html lo escapa); un
 * alt vuoto non lascia niente. Per i testi di una DOMANDA dell'agente: il
 * contenuto del ticket non è fidato e può far scrivere all'agente un'immagine
 * remota che fa da pixel di tracciamento verso chi apre l'inbox — stessa
 * dottrina delle immagini remote della posta.
 */
const IMAGE_AS_ALT: sanitizeHtml.IOptions["transformTags"] = {
  img: (_tagName, attribs) => ({ tagName: "span", attribs: {}, text: attribs.alt ?? "" }),
};

/** {@link SANITIZE_OPTIONS} senza immagini: ogni `<img>` diventa il suo alt. */
const QUESTION_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  ...SANITIZE_OPTIONS,
  allowedTags: (SANITIZE_OPTIONS.allowedTags as string[]).filter((tag) => tag !== "img"),
  transformTags: IMAGE_AS_ALT,
};

/**
 * Markdown renderizzato e sanitizzato. La sorgente può arrivare da utenti,
 * SDK o dall'AI: mai fidarsi. Lo stile vive nella classe `.markdown` globale.
 *
 * `question`: il testo di una domanda dell'agente (sessione, inbox, ticket,
 * backlog) — le immagini NON si caricano, resta l'alt. Fuori dalle domande
 * (testo dell'agente, corpo del ticket, Docs) le immagini restano.
 */
export function Markdown({ source, question = false }: { source: string; question?: boolean }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true, breaks: true });
    return sanitizeHtml(raw, question ? QUESTION_SANITIZE_OPTIONS : SANITIZE_OPTIONS);
  }, [source, question]);

  // dangerouslySetInnerHTML è sicuro qui: l'HTML è sanitizzato qui sopra.
  return <div className="markdown text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Solo formattazione di testo: niente link (un `<a>` dentro un radio sarebbe un interattivo annidato), niente blocchi. */
const INLINE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // `span` solo per l'immagine trasformata nel suo alt: senza, sanitize-html
  // scarterebbe anche il testo che la segue.
  allowedTags: ["code", "em", "strong", "del", "span"],
  allowedAttributes: {},
  // Serve solo ai testi di una domanda: un'immagine è il suo alt, mai un caricamento.
  transformTags: IMAGE_AS_ALT,
};

/**
 * Markdown INLINE (`marked.parseInline`, stessa pipeline e stesso sanitizer di
 * `Markdown`, allowlist ridotta): per testi che stanno dentro un controllo —
 * etichette e conseguenze delle opzioni di una domanda. Uno `span`, nessun
 * margine di blocco; un link diventa il suo testo; il nome accessibile
 * resta il testo senza i segni del markdown.
 */
/**
 * Come `marked`, ma l'HTML grezzo nel testo (`<span>`) resta TESTO visibile e
 * l'a-capo forzato diventa uno spazio: in un'etichetta lo sanitizer lo
 * toglierebbe in silenzio, cambiando le parole e il nome accessibile.
 */
const inlineMarked = new Marked({
  renderer: {
    html(token) {
      const raw = typeof token === "string" ? token : token.text;
      return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    br() {
      return " ";
    },
  },
});

export function InlineMarkdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = inlineMarked.parseInline(source, { async: false, gfm: true, breaks: false });
    return sanitizeHtml(raw, INLINE_SANITIZE_OPTIONS);
  }, [source]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
