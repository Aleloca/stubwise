/**
 * `@stubwise/i18n` — traduzione DB-free dei testi generati dal backend.
 *
 * Funzioni pure (nessuna dipendenza su `@stubwise/db`): cercano una chiave nel
 * catalogo della lingua richiesta, interpolano i segnaposto `{param}` e fanno
 * fallback su `en` se la chiave manca. I cataloghi vivono in `./catalog.ts`.
 *
 * Il type `Language` è RIUSATO da `@stubwise/shared` (unica fonte di verità per
 * i valori di lingua, condivisa con DB/server/web) per non duplicarlo.
 */
import type { Language } from "@stubwise/shared";
import { catalogs } from "./catalog.js";

export type { Language };
export { en, it, catalogs, type Catalog } from "./catalog.js";

/** Nomi visualizzabili (in inglese) delle lingue supportate. */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  it: "Italian",
};

/** Sostituisce ogni `{key}` in `template` con `params[key]` (stringificato). */
function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/**
 * Traduce `key` nella lingua `lang`, interpolando i `params`. Se la chiave manca
 * in `lang` fa fallback al testo `en`; se manca anche lì ritorna la chiave stessa
 * (utile in dev per individuare chiavi non tradotte).
 */
export function t(
  lang: Language,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = catalogs[lang][key] ?? catalogs.en[key] ?? key;
  return interpolate(template, params);
}

/** Nome visualizzabile (in inglese) della lingua: `"English"` | `"Italian"`. */
export function languageName(lang: Language): string {
  return LANGUAGE_NAMES[lang];
}
