import type { Language } from "@stubwise/shared";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";

/**
 * Namespace dell'app: ogni file di lingua (`en.json`/`it.json`) ha una chiave
 * top-level per namespace. `common` è il default, così `t("foo")` legge da
 * `common`; gli altri si interrogano con la sintassi `t("ns:key")` (es.
 * `t("errors:ticket_not_found")`).
 */
export const NAMESPACES = [
  "common",
  "errors",
  "auth",
  "tickets",
  "backlog",
  "settings",
  "notifications",
  "automation",
  "usage",
  "jobStatus",
  "badges",
  "projects",
  "repositories",
  "monitor",
  "integration",
  "milestones",
  "savedViews",
  "envFiles",
  "docs",
  "search",
  "widget",
  "activity",
] as const;

/**
 * Lingua iniziale pre-login: `it` se il browser è in italiano, altrimenti `en`.
 * Dopo il login `i18n.changeLanguage(user.language)` allinea la UI alla
 * preferenza persistita dell'utente (vedi AppLayout).
 */
function initialLanguage(): Language {
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("it")) {
    return "it";
  }
  return "en";
}

// L'init è sincrono (resource inlinate, niente backend HTTP): al ritorno di
// questo modulo i18n è pronto e `main.tsx` può renderizzare senza Suspense.
void i18n.use(initReactI18next).init({
  resources: { en, it },
  lng: initialLanguage(),
  fallbackLng: "en",
  ns: NAMESPACES as unknown as string[],
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

export default i18n;
