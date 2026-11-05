import type { ProductBlockType } from "../../data/model";

/** Il menu «/» e le scorciatoie digitate dell'editor (shape `product-editor.md` §3.4). */

export type SlashItemId =
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bullet"
  | "numbered"
  | "todo"
  | "table"
  | "quote"
  | "divider"
  | "image"
  | "drive"
  | "link"
  | "decision";

/** Il gruppo del menu: TEXT / TESTO cambia il blocco, INSERT / INSERISCI mette un oggetto. */
export type SlashGroup = "text" | "insert";

export interface SlashItem {
  id: SlashItemId;
  group: SlashGroup;
  /** La chiave i18n del nome (le chiavi nascono col menu, Task 8). */
  labelKey: string;
  /** Parole in più che il filtro riconosce, uguali in ogni lingua. */
  keywords: string[];
}

const item = (id: SlashItemId, group: SlashGroup, keywords: string[]): SlashItem => ({
  id,
  group,
  labelKey: `productDocs.editor.slash.${id}`,
  keywords,
});

/** Le voci nell'ordine dello shape: TEXT, poi INSERT (da «table»). Il 11b aggiunge "wireframe" in INSERT. */
export const SLASH_ITEMS: readonly SlashItem[] = [
  item("heading1", "text", ["h1", "#"]),
  item("heading2", "text", ["h2", "##"]),
  item("heading3", "text", ["h3", "###"]),
  item("paragraph", "text", ["p"]),
  item("bullet", "text", ["ul", "-"]),
  item("numbered", "text", ["ol", "1."]),
  item("todo", "text", ["[]", "checkbox"]),
  item("quote", "text", [">"]),
  item("divider", "text", ["hr", "---"]),
  item("table", "insert", []),
  item("image", "insert", ["png", "jpeg", "gif", "webp"]),
  item("drive", "insert", []),
  item("link", "insert", []),
  item("decision", "insert", []),
];

/**
 * Le voci per ciò che si scrive dopo «/»: il nome nella lingua
 * dell'interfaccia (`label`) o una parola chiave contengono il testo, senza
 * badare a maiuscole e spazi ai lati. Vuoto: tutte, nell'ordine.
 */
export function filterSlashItems(q: string, label: (key: string) => string): SlashItem[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter(
    (i) => label(i.labelKey).toLowerCase().includes(needle) || i.keywords.some((k) => k.includes(needle)),
  );
}

const SHORTCUTS: { prefix: string; type: ProductBlockType; level?: 1 | 2 | 3 }[] = [
  { prefix: "### ", type: "heading", level: 3 },
  { prefix: "## ", type: "heading", level: 2 },
  { prefix: "# ", type: "heading", level: 1 },
  { prefix: "- ", type: "bullet" },
  { prefix: "* ", type: "bullet" },
  { prefix: "1. ", type: "numbered" },
  { prefix: "[] ", type: "todo" },
  { prefix: "> ", type: "quote" },
];

/**
 * Le scorciatoie in testa a un blocco: «# » → titolo 1, «## », «### », «- »
 * e «* » → elenco puntato, «1. » → numerato, «[] » → to-do, «> » →
 * citazione, «---» (da solo) → separatore. `rest` è il testo dopo la
 * scorciatoia, che resta nel blocco; i segni della scorciatoia spariscono.
 * Senza lo spazio («#Titolo») o non in testa («Totale #1»): `null`.
 */
export function typeShortcut(text: string): { type: ProductBlockType; level?: 1 | 2 | 3; rest: string } | null {
  if (text === "---") return { type: "divider", rest: "" };
  for (const s of SHORTCUTS) {
    if (!text.startsWith(s.prefix)) continue;
    const rest = text.slice(s.prefix.length);
    return s.level === undefined ? { type: s.type, rest } : { type: s.type, level: s.level, rest };
  }
  return null;
}
