import { afterEach, describe, expect, it } from "vitest";
import i18n, { LANGUAGE_STORAGE_KEY, setLanguage } from "./index";

afterEach(() => {
  setLanguage("en");
  window.localStorage.clear();
});

describe("lingua", () => {
  it("di default è en", () => {
    expect(i18n.language).toBe("en");
    expect(i18n.t("nav.home")).toBe("Home");
  });

  it("setLanguage cambia lingua e la persiste", () => {
    setLanguage("it");
    expect(i18n.language).toBe("it");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("it");
  });

  it("tiene <html lang> allineato alla lingua", () => {
    expect(document.documentElement.lang).toBe("en");
    setLanguage("it");
    expect(document.documentElement.lang).toBe("it");
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
