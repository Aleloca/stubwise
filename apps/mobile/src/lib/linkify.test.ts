import { isOpenableUrl, linkify } from "./linkify";

describe("linkify", () => {
  it("un testo senza link resta un pezzo solo", () => {
    expect(linkify("Ciao, ci vediamo domani.")).toEqual([{ kind: "text", text: "Ciao, ci vediamo domani." }]);
  });

  it("riconosce un link in mezzo a una frase", () => {
    expect(linkify("Guarda https://stubwise.thecove.it/mail e dimmi.")).toEqual([
      { kind: "text", text: "Guarda " },
      { kind: "link", text: "https://stubwise.thecove.it/mail", url: "https://stubwise.thecove.it/mail" },
      { kind: "text", text: " e dimmi." },
    ]);
  });

  it("il punto che chiude la frase non entra nel link", () => {
    const segments = linkify("Vai su https://esempio.it/pagina.");
    expect(segments[1]).toEqual({ kind: "link", text: "https://esempio.it/pagina", url: "https://esempio.it/pagina" });
    expect(segments[2]).toEqual({ kind: "text", text: "." });
  });

  it("un punto DENTRO il percorso resta nel link", () => {
    const [link] = linkify("https://esempio.it/file.pdf");
    expect(link).toEqual({ kind: "link", text: "https://esempio.it/file.pdf", url: "https://esempio.it/file.pdf" });
  });

  it("`www.` senza schema diventa https", () => {
    const [link] = linkify("www.esempio.it");
    expect(link).toEqual({ kind: "link", text: "www.esempio.it", url: "https://www.esempio.it" });
  });

  it("più link nella stessa riga", () => {
    const segments = linkify("https://a.it e https://b.it");
    expect(segments.filter((s) => s.kind === "link").map((s) => s.text)).toEqual(["https://a.it", "https://b.it"]);
  });

  it("uno schema che non è http NON diventa un link", () => {
    // La difesa vera è qui: il testo di un'email lo scrive chiunque, e un
    // `javascript:`/`file:`/schema di un'altra app non deve mai arrivare a
    // `Linking.openURL`.
    for (const ostile of ["javascript:alert(1)", "file:///etc/passwd", "tg://resolve?domain=x", "data:text/html,<b>"]) {
      expect(linkify(ostile).every((s) => s.kind === "text")).toBe(true);
    }
  });

  it("gli asterischi e i trattini restano letterali: non è markdown", () => {
    const testo = "**non grassetto** e - non elenco";
    expect(linkify(testo)).toEqual([{ kind: "text", text: testo }]);
  });

  it("un testo vuoto non produce pezzi", () => {
    expect(linkify("")).toEqual([]);
  });

  it("il link a fine testo non lascia un pezzo di testo vuoto in coda", () => {
    expect(linkify("Apri https://a.it")).toEqual([
      { kind: "text", text: "Apri " },
      { kind: "link", text: "https://a.it", url: "https://a.it" },
    ]);
  });
});

describe("isOpenableUrl", () => {
  it("http e https sì, tutto il resto no", () => {
    expect(isOpenableUrl("https://esempio.it")).toBe(true);
    expect(isOpenableUrl("http://esempio.it")).toBe(true);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("non un url")).toBe(false);
  });
});
