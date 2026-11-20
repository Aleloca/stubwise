/**
 * Scappa `&`, `<` e `>`: un testo non fidato non apre né chiude un blocco del
 * prompt (`mail-calendar.md`, «Contenuto NON fidato»). Una regola sola per la
 * posta (`mail-claude-draft.ts`) e le pagine di prodotto nella chat dei Docs.
 */
export function escapeUntrusted(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
