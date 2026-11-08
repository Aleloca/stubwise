import { describe, expect, it } from "vitest";
import { guessLanguage, languageName, normalizeLanguage } from "./codeLanguages";

describe("normalizeLanguage e languageName", () => {
  it("soprannomi, testo semplice e sconosciuti puliti", () => {
    expect(normalizeLanguage("JS")).toBe("javascript");
    expect(normalizeLanguage("Plain text")).toBeUndefined();
    expect(normalizeLanguage("Kotlin")).toBe("kotlin");
    expect(normalizeLanguage("no spaces allowed")).toBeUndefined();
    expect(languageName("json")).toBe("JSON");
    expect(languageName("kotlin")).toBe("Kotlin");
  });
});

describe("guessLanguage: solo quando è sicuro", () => {
  it("JSON valido, oggetto o elenco", () => {
    expect(guessLanguage('{\n  "sid": "CA1",\n  "n": 1\n}')).toBe("json");
    expect(guessLanguage("[1, 2]")).toBe("json");
  });

  it("XML: la dichiarazione o un elemento chiuso da capo a fondo", () => {
    expect(guessLanguage('<?xml version="1.0"?>\n<Response/>')).toBe("xml");
    expect(guessLanguage("<Response>\n  <Say>Ciao</Say>\n</Response>")).toBe("xml");
    expect(guessLanguage('<Stream url="wss://x" />')).toBe("xml");
  });

  it("nel dubbio testo semplice: JSON rotto, HTTP, HTML, frasi", () => {
    expect(guessLanguage('{ "event": "start", "accountSid": "AC..." ')).toBeUndefined();
    expect(guessLanguage("{ event: start }")).toBeUndefined();
    expect(guessLanguage("POST /calls HTTP/1.1\nContent-Type: application/json")).toBeUndefined();
    expect(guessLanguage("<html><body>x</body></html>")).toBeUndefined();
    expect(guessLanguage("1. Chiamata in arrivo → <Connect>")).toBeUndefined();
    expect(guessLanguage("<a> e poi testo")).toBeUndefined();
    expect(guessLanguage('<div class="x"><p>a</p></div>')).toBeUndefined();
    expect(guessLanguage("<br/>")).toBeUndefined();
  });
});
