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

/**
 * Regole responsive/mobile puramente CSS: le verifichiamo come presenza nella
 * stringa (il layout effettivo non è testabile in happy-dom).
 */
describe("widgetStyles mobile/anti-zoom rules", () => {
  const css = widgetStyles("#3366ff");

  it("il composer e gli input della card hanno font-size 16px (no auto-zoom iOS)", () => {
    // Entrambi i selettori dell'input usano 16px.
    expect(css).toMatch(/\.sw-composer-input\s*\{[^}]*font-size:\s*16px/);
    expect(css).toMatch(/\.sw-input,\s*\.sw-textarea\s*\{[^}]*font-size:\s*16px/);
  });

  it("il composer ha touch-action: manipulation", () => {
    expect(css).toMatch(/\.sw-composer\s*\{[^}]*touch-action:\s*manipulation/);
  });

  it("sotto i 480px la bolla nascosta ha display:none", () => {
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toMatch(/\.sw-bubble--hidden\s*\{\s*display:\s*none/);
  });
});
