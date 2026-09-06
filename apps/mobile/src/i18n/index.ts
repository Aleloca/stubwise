import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

/**
 * i18next dell'app mobile: solo `mobile.*` (namespace unico per ora — non
 * c'è ancora nient'altro da tradurre). Copy italiano preso 1:1 dal canvas
 * (`designs/app-design.zip`); inglese tradotto a mano.
 *
 * Lingua di default `it`: prima del login non c'è ancora una `SessionUser`
 * da cui leggere la preferenza (arriva solo con `mobileLogin`/`me`), e
 * l'istanza di riferimento (`stubwise.thecove.it`) è italiana. Dopo il
 * login, chi monta la sessione richiama {@link setLanguage} con
 * `user.language`.
 */
void i18n.use(initReactI18next).init({
  compatibilityJSON: "v4",
  resources: {
    it: { translation: it },
    en: { translation: en },
  },
  lng: "it",
  fallbackLng: "it",
  interpolation: { escapeValue: false },
});

/** Allinea la lingua dell'app a quella salvata sull'utente (`SessionUser.language`). */
export function setLanguage(language: "it" | "en"): void {
  void i18n.changeLanguage(language);
}

export default i18n;
