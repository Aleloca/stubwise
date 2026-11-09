// I linguaggi del blocco di codice (prove a mano del 7 nov 2026, decisione
// del maintainer: un'etichetta, niente colori della sintassi). Un solo
// elenco per l'editor (la scelta), l'incolla (da `language-json`, «```json»
// o, senza etichetta, `guessLanguage`) e l'esportazione (l'etichetta sopra il codice).

/** I linguaggi che si scelgono a mano, con il loro nome. Le chiavi sono in minuscolo. */
export const CODE_LANGUAGES: readonly { id: string; name: string }[] = [
  { id: "bash", name: "Bash" },
  { id: "css", name: "CSS" },
  { id: "html", name: "HTML" },
  { id: "javascript", name: "JavaScript" },
  { id: "json", name: "JSON" },
  { id: "python", name: "Python" },
  { id: "sql", name: "SQL" },
  { id: "typescript", name: "TypeScript" },
  { id: "xml", name: "XML" },
  { id: "yaml", name: "YAML" },
];

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  yml: "yaml",
  htm: "html",
};

/**
 * Il linguaggio come lo salva il blocco: in minuscolo, coi soprannomi più
 * comuni ricondotti al nome («js» → «javascript»). Vuoto, «text», «plain» o
 * «plaintext» = testo semplice (`undefined`). Uno sconosciuto ma pulito
 * resta com'è (al più 20 caratteri di lettere, cifre, «+», «#», «-»), così
 * un «Kotlin» incollato non si perde; tutto il resto è testo semplice.
 */
export function normalizeLanguage(raw: string | null | undefined): string | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s === "text" || s === "plain" || s === "plaintext" || s === "plain text") return undefined;
  if (!/^[a-z0-9+#-]{1,20}$/.test(s)) return undefined;
  return ALIASES[s] ?? s;
}

/** Il nome da mostrare: quello dell'elenco, o lo sconosciuto con l'iniziale maiuscola. */
export function languageName(id: string): string {
  return CODE_LANGUAGES.find((l) => l.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** I tag dell'HTML comune: un frammento che comincia così non è «sicuramente» XML. */
const HTML_TAGS = new Set(
  "html head body div span p a br hr img ul ol li table tr td th thead tbody section article header footer nav main button input form label script style link meta h1 h2 h3 h4 h5 h6 b i em strong code pre".split(
    " ",
  ),
);

/**
 * Il linguaggio di un codice incollato senza etichetta (Google Docs non la
 * mette negli appunti), solo quando è sicuro (decisione del maintainer, 9
 * nov 2026): JSON se il testo è un oggetto o un elenco JSON valido, XML se
 * comincia con `<?xml` o è un elemento chiuso da capo a fondo. Altrimenti
 * `undefined`: testo semplice, il linguaggio si sceglie a mano.
 */
export function guessLanguage(text: string): string | undefined {
  const s = text.trim();
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      return undefined;
    }
  }
  if (s.startsWith("<?xml")) return "xml";
  const root = /^<([A-Za-z][\w.:-]*)[\s>/]/.exec(s)?.[1];
  if (root === undefined || HTML_TAGS.has(root.toLowerCase())) return undefined;
  return s.endsWith(`</${root}>`) || /^<[^<>]*\/>$/.test(s) ? "xml" : undefined;
}
