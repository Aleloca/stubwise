import { describe, expect, it } from "vitest";
import { isSafeJoinUrl, isSafeWebUrl } from "./safe-url.js";

/**
 * La regola di sicurezza sugli schemi (15 set 2026, fix di review).
 *
 * I test stanno DOVE STA LA REGOLA, non accanto a ciascuno dei tre punti che
 * la usavano: era proprio la dispersione il difetto — due copie di una
 * regola di sicurezza divergono, e la copia che diverge è quella che lascia
 * passare.
 */

/** Gli schemi che non devono passare da NESSUNA delle due porte. */
const HOSTILE = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
  // Uno schema custom di un'altra app installata: aprirlo significa
  // consegnare il controllo a qualcosa che non conosciamo.
  "myapp://do-something",
  "intent://scan/#Intent;scheme=zxing;end",
];

/** Stringhe che non sono URL affatto. */
const NOT_URLS = ["", "   ", "non un url", "esempio.it", "www.esempio.it", "//esempio.it"];

describe("isSafeWebUrl — un link TROVATO dentro testo non fidato", () => {
  it("http e https passano", () => {
    expect(isSafeWebUrl("https://esempio.it/pagina")).toBe(true);
    expect(isSafeWebUrl("http://esempio.it")).toBe(true);
    expect(isSafeWebUrl("HTTPS://ESEMPIO.IT")).toBe(true);
  });

  it("gli schemi ostili non passano", () => {
    for (const url of HOSTILE) expect(isSafeWebUrl(url)).toBe(false);
  });

  it("⚠️ `tel:` NON passa da qui, ed è deliberato", () => {
    // Un `tel:` comparso in mezzo al corpo di un'email non è un numero di
    // conferenza dichiarato da Google: è testo che qualcuno ha scritto.
    // Allargare QUESTA regola «perché tanto l'altra lo ammette» riaprirebbe
    // la porta dove il contenuto è meno fidato.
    expect(isSafeWebUrl("tel:+39061234567")).toBe(false);
  });

  it("ciò che non è un URL non passa", () => {
    for (const url of NOT_URLS) expect(isSafeWebUrl(url)).toBe(false);
  });
});

describe("isSafeJoinUrl — un MODO DI PARTECIPARE dichiarato da Google", () => {
  it("http, https e tel passano", () => {
    expect(isSafeJoinUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isSafeJoinUrl("http://conf.example.test/room")).toBe(true);
    expect(isSafeJoinUrl("tel:+39061234567")).toBe(true);
  });

  it("gli schemi ostili non passano NEMMENO da qui", () => {
    for (const url of HOSTILE) expect(isSafeJoinUrl(url)).toBe(false);
  });

  it("ciò che non è un URL non passa", () => {
    for (const url of NOT_URLS) expect(isSafeJoinUrl(url)).toBe(false);
  });
});

describe("le due regole restano DUE, e la differenza è esattamente una", () => {
  it("l'unica cosa che le distingue è `tel:`", () => {
    // Se un giorno questo test diventasse rosso, qualcuno ha allargato una
    // delle due senza accorgersi di quale: è il punto del file.
    const cases = [
      ...HOSTILE,
      ...NOT_URLS,
      "https://esempio.it",
      "http://esempio.it",
      "tel:+39061234567",
    ];
    const divergent = cases.filter((url) => isSafeWebUrl(url) !== isSafeJoinUrl(url));
    expect(divergent).toEqual(["tel:+39061234567"]);
  });
});
