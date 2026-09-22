import { UNKNOWN } from "@stubwise/shared";
import i18n from "../i18n";
import { ticketHeading } from "./ticket-labels";

const t = i18n.t.bind(i18n);
const ORA = new Date("2026-09-22T12:00:00.000Z").getTime();
const giorniFa = (n: number) => new Date(ORA - n * 24 * 60 * 60 * 1000).toISOString();

describe("ticketHeading — la riga grigia di testa", () => {
  it("con tutti i pezzi li mette in fila, separati da ·", () => {
    expect(
      ticketHeading(
        { ticketNumber: 27, priority: "urgent", type: "bug", createdAt: giorniFa(8) },
        t,
        ORA,
      ),
    ).toBe("#27 · urgente · guasto · aperto 8 g fa");
  });

  it("un pezzo assente si porta via il suo separatore", () => {
    // `#27 · · guasto` è peggio di `#27 · guasto`.
    expect(ticketHeading({ ticketNumber: 27, type: "bug" }, t, ORA)).toBe("#27 · guasto");
  });

  it("SERVER PIÙ VECCHIO: senza nessuno dei tre resta il numero, che c'è sempre", () => {
    expect(ticketHeading({ ticketNumber: 27 }, t, ORA)).toBe("#27");
  });

  it("⚠️ una data ILLEGGIBILE non diventa «aperto oggi»: il pezzo sparisce", () => {
    // È il caso che conta, e il `null` di `openedSince` da solo non lo
    // proverebbe: quello che va verificato è che la riga NON contenga
    // «aperto», cioè che nessuno abbia rimesso un ripiego a valle.
    const riga = ticketHeading(
      { ticketNumber: 27, priority: "urgent", type: "bug", createdAt: "non-una-data" },
      t,
      ORA,
    );
    expect(riga).toBe("#27 · urgente · guasto");
    expect(riga).not.toContain("aperto");
  });

  it("oltre i due mesi l'età si dice in mesi", () => {
    expect(ticketHeading({ ticketNumber: 27, createdAt: giorniFa(75) }, t, ORA)).toBe(
      "#27 · aperto 2 mesi",
    );
  });

  it("un tipo che questa build non conosce non si stampa grezzo", () => {
    // `readerSchema` apre gli enum: un sesto tipo arriva come UNKNOWN, e la
    // riga dice «sconosciuto» invece del valore del server.
    const riga = ticketHeading({ ticketNumber: 27, type: UNKNOWN }, t, ORA);
    expect(riga).toBe("#27 · sconosciuto");
  });
});
