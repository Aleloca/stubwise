import i18n from "i18next";
import { initReactI18next } from "react-i18next";
// Solo i rami che la pagina a sé usa: Vite tira dentro le sole chiavi
// importate per nome, non le due locali intere (I-2: niente dell'app).
import { rail as enRail, vault as enVault } from "../i18n/locales/en.json";
import { rail as itRail, vault as itVault } from "../i18n/locales/it.json";
import { LANGUAGE_STORAGE_KEY } from "../i18n/storageKey";

function readStoredLanguage(): "en" | "it" {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return value === "it" ? "it" : "en";
  } catch {
    return "en";
  }
}

const lng = readStoredLanguage();
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: { vault: enVault, rail: enRail } },
    it: { translation: { vault: itVault, rail: itRail } },
  },
  lng,
  fallbackLng: "en",
  defaultNS: "translation",
  interpolation: { escapeValue: false },
});
document.documentElement.lang = lng;

export default i18n;
