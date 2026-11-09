import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";

export type Language = "en" | "it";

export const LANGUAGE_STORAGE_KEY = "stubwise.language";

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "it";
}

/** Legge la lingua salvata; storage assente, bloccato o valore ignoto → `en`. */
function readStoredLanguage(): Language {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : "en";
  } catch {
    return "en";
  }
}

/** Allinea `<html lang>` alla lingua (senza DOM non fa nulla). */
function syncHtmlLang(lang: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

const initialLanguage = readStoredLanguage();

// Init sincrono (risorse inlinate): al ritorno del modulo i18n è pronto.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: initialLanguage,
  fallbackLng: "en",
  defaultNS: "translation",
  interpolation: { escapeValue: false },
});

syncHtmlLang(initialLanguage);

/** Cambia lingua e la persiste; un errore di storage non è fatale. */
export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  syncHtmlLang(lang);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // storage bloccato: la scelta vale per la sessione
  }
}

export default i18n;
