import { sanitizeEmailHtml } from "@stubwise/google";
import { describe, expect, it } from "vitest";
import { numberRemoteImages, remoteImageUrls } from "./number.js";

// La posizione di un'immagine (design §2): la stessa numerazione nella risposta
// di `/original` e nella rotta delle immagini, sull'HTML GIÀ sanificato.

const RAW = `<p>Ciao</p>
<img src="https://a.example/1.png?x=1&y=2" alt="uno">
<img src="data:image/png;base64,AAAA" alt="inline">
<img src="javascript:alert(1)">
<p><img src="https://b.example/2.jpg" width="10" height="20"></p>
<img src="http://c.example/3.gif">`;

describe("numberRemoteImages / remoteImageUrls", () => {
  it("numera, in ordine di documento, solo le immagini remote che il sanificatore lascia", () => {
    const html = sanitizeEmailHtml(RAW);
    expect(remoteImageUrls(html)).toEqual(["https://a.example/1.png?x=1&y=2", "https://b.example/2.jpg", "http://c.example/3.gif"]);
    const numbered = numberRemoteImages(html);
    expect([...numbered.matchAll(/data-image="(\d+)"/g)].map((m) => m[1])).toEqual(["0", "1", "2"]);
    expect(numbered).toContain('data-src="https://a.example/1.png?x=1&amp;y=2"');
    // Lo stesso elenco anche dall'HTML numerato: la rotta e la risposta concordano.
    expect(remoteImageUrls(numbered)).toEqual(remoteImageUrls(html));
  });

  it("un data-image scritto dal mittente non sopravvive al sanificatore, e numerare due volte non raddoppia", () => {
    const html = sanitizeEmailHtml('<img src="https://a.example/x.png" data-image="7">');
    expect(html).not.toContain('data-image="7"');
    const once = numberRemoteImages(html);
    expect(numberRemoteImages(once)).toBe(once);
  });

  it("niente immagini remote: l'HTML resta com'è e l'elenco è vuoto", () => {
    const html = sanitizeEmailHtml("<p>solo testo</p>");
    expect(numberRemoteImages(html)).toBe(html);
    expect(remoteImageUrls(html)).toEqual([]);
  });
});
