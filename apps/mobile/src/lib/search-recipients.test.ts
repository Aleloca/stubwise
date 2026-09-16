import { othersThan, summarizeAddresses } from "./search-recipients";

/**
 * Chi altro vede un'email (16 set 2026, design §3.1 regole 1 e 2).
 *
 * Il caso che conta più degli altri: quando dopo il filtro non resta nessuno
 * il risultato è VUOTO, e il chiamante non disegna la riga. Una riga «a: —»
 * occupa spazio per dire niente.
 */

const MAILBOX = "a.locatelli@thecove.it";

describe("othersThan — l'indirizzo della casella esce", () => {
  it("toglie la casella che ha ricevuto", () => {
    expect(othersThan(["a.locatelli@thecove.it", "m.misseri@thecove.it"], MAILBOX)).toEqual([
      "m.misseri@thecove.it",
    ]);
  });

  it("confronto case-insensitive e tollerante agli spazi", () => {
    expect(othersThan([" A.Locatelli@TheCove.it "], MAILBOX)).toEqual([]);
  });

  it("⚠️ se resta solo la tua casella, non resta NIENTE", () => {
    // Il chiamante in questo caso non disegna la riga affatto.
    expect(othersThan([MAILBOX], MAILBOX)).toEqual([]);
  });

  it("scarta le stringhe vuote invece di contarle come destinatari", () => {
    expect(othersThan(["", "   ", "m.misseri@thecove.it"], MAILBOX)).toEqual(["m.misseri@thecove.it"]);
  });

  it("un elenco senza la tua casella resta intero", () => {
    const others = ["uno@acme.test", "due@acme.test"];
    expect(othersThan(others, MAILBOX)).toEqual(others);
  });
});

describe("summarizeAddresses — la parte locale più `+N`", () => {
  it("uno solo: la sola parte locale", () => {
    expect(summarizeAddresses(["m.misseri@thecove.it"])).toBe("m.misseri");
  });

  it("più d'uno: il primo più quanti altri", () => {
    expect(summarizeAddresses(["m.misseri@thecove.it", "a@b.test", "c@d.test"])).toBe("m.misseri +2");
  });

  it("nessuno: `null`, il segnale per non disegnare la riga", () => {
    expect(summarizeAddresses([])).toBeNull();
  });

  it("un valore che non è un indirizzo si mostra com'è, non tagliato a caso", () => {
    expect(summarizeAddresses(["undisclosed-recipients"])).toBe("undisclosed-recipients");
    // `@` in prima posizione: `slice(0, 0)` darebbe una stringa vuota.
    expect(summarizeAddresses(["@strano"])).toBe("@strano");
  });
});
