import { describe, expect, it } from "vitest";
import { widgetStyles } from "./styles.js";

/**
 * Il colore d'accento viene interpolato grezzo dentro un `<style>`: va accettato
 * solo se è un hex valido, altrimenti si ripiega sul default (niente CSS
 * arbitrario iniettato via config).
 */
describe("widgetStyles accent sanitization", () => {
  it("accetta un hex valido (3-8 cifre)", () => {
    expect(widgetStyles("#abc")).toContain("--sw-accent: #abc;");
    expect(widgetStyles("#3366ff")).toContain("--sw-accent: #3366ff;");
    expect(widgetStyles("#3366ffcc")).toContain("--sw-accent: #3366ffcc;");
  });

  it("ripiega sul default su valore non-hex (niente iniezione)", () => {
    const css = widgetStyles("red; } body { display:none } .x{");
    expect(css).toContain("--sw-accent: #3b82f6;");
    expect(css).not.toContain("display:none");
  });
});
