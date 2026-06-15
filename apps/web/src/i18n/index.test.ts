import { afterEach, describe, expect, it as test } from "vitest";
import i18n, { NAMESPACES } from "./index";

// Ogni test riporta i18n alla lingua di default per non far dipendere l'esito
// dall'ordine di esecuzione.
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("init i18n", () => {
  test("carica le risorse en e it", () => {
    expect(i18n.hasResourceBundle("en", "errors")).toBe(true);
    expect(i18n.hasResourceBundle("it", "errors")).toBe(true);
  });

  test("registra tutti i namespace previsti", () => {
    for (const ns of NAMESPACES) {
      expect(i18n.hasResourceBundle("en", ns)).toBe(true);
      expect(i18n.hasResourceBundle("it", ns)).toBe(true);
    }
  });

  test("ha il fallback su en", () => {
    expect(i18n.options.fallbackLng).toContain("en");
  });

  test("risolve una chiave del namespace errors con la sintassi ns:key", () => {
    expect(i18n.t("errors:ticket_not_found")).toBe("Ticket not found");
  });

  test("defaultNS è common: t('appName') legge da common", () => {
    expect(i18n.t("appName")).toBe("Stubwise");
  });
});

describe("changeLanguage", () => {
  test("cambia la lingua attiva e le traduzioni", async () => {
    await i18n.changeLanguage("it");
    expect(i18n.language).toBe("it");
    expect(i18n.t("errors:ticket_not_found")).toBe("Ticket non trovato");
  });
});
