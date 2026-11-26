import i18n from "../../i18n";
import en from "../../i18n/locales/personas.en.json";
import it from "../../i18n/locales/personas.it.json";

// Le descrizioni delle persone del «vedi come» (`rail.personas.<personId>`):
// sono dati del seme, non testi del prodotto, quindi stanno fuori da
// `en.json`/`it.json` e le aggiunge solo il prototipo (integrazione area 2,
// fetta 1: nessun dato del seme nella build app). Le importa `viewer.ts`.
i18n.addResourceBundle("en", "translation", { rail: { personas: en } }, true, false);
i18n.addResourceBundle("it", "translation", { rail: { personas: it } }, true, false);
