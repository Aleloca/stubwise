import { describe, expect, it } from "vitest";
import { attendeeResponseOf, hasDeclinedInvitation } from "./calendar-attendance.js";
import { UNKNOWN } from "./reader.js";

/**
 * «Qual è la TUA risposta» (design 15 set 2026 §1).
 *
 * Il caso che questo file presidia più degli altri è l'ULTIMO: la casella che
 * NON è fra i partecipanti non è un rifiuto. È l'errore che costerebbe caro,
 * perché non lascerebbe traccia — un appuntamento che smette di proporre
 * senza che nessuno se ne accorga.
 */

const ME = "a.locatelli@thecove.it";

describe("attendeeResponseOf", () => {
  it("legge le quattro risposte di Google", () => {
    for (const status of ["declined", "accepted", "tentative", "needsAction"] as const) {
      expect(attendeeResponseOf([{ email: ME, responseStatus: status }], ME)).toBe(status);
    }
  });

  it("la tua casella NON fra i partecipanti non è un rifiuto: è `null`", () => {
    const attendees = [
      { email: "cliente@acme.test", responseStatus: "declined" },
      { email: "collega@thecove.it", responseStatus: "accepted" },
    ];
    expect(attendeeResponseOf(attendees, ME)).toBeNull();
    expect(hasDeclinedInvitation(attendees, ME)).toBe(false);
  });

  it("un evento senza partecipanti (è tuo e basta) è `null`, non un rifiuto", () => {
    expect(attendeeResponseOf([], ME)).toBeNull();
    expect(hasDeclinedInvitation([], ME)).toBe(false);
  });

  it("confronto case-insensitive e tollerante agli spazi", () => {
    expect(attendeeResponseOf([{ email: "A.Locatelli@TheCove.it", responseStatus: "declined" }], ME)).toBe(
      "declined",
    );
    expect(attendeeResponseOf([{ email: ME, responseStatus: "declined" }], " A.LOCATELLI@thecove.it ")).toBe(
      "declined",
    );
  });

  it("uno stato assente o non riconosciuto è `null`, mai un valore inventato", () => {
    expect(attendeeResponseOf([{ email: ME, responseStatus: null }], ME)).toBeNull();
    expect(attendeeResponseOf([{ email: ME, responseStatus: "maybe-later" }], ME)).toBeNull();
    // Il segnaposto degli enum aperti (`Reader`, app mobile vecchia) cade
    // nello stesso ramo: non lo sappiamo leggere, quindi non lo diciamo.
    expect(attendeeResponseOf([{ email: ME, responseStatus: UNKNOWN }], ME)).toBeNull();
  });

  it("una casella vuota non combacia con nessuno", () => {
    expect(attendeeResponseOf([{ email: "", responseStatus: "declined" }], "")).toBeNull();
  });
});

describe("hasDeclinedInvitation — solo `declined` blocca", () => {
  it("rifiutato blocca", () => {
    expect(hasDeclinedInvitation([{ email: ME, responseStatus: "declined" }], ME)).toBe(true);
  });

  it("forse e senza risposta NON bloccano (decisione del maintainer sui dati veri)", () => {
    expect(hasDeclinedInvitation([{ email: ME, responseStatus: "tentative" }], ME)).toBe(false);
    expect(hasDeclinedInvitation([{ email: ME, responseStatus: "needsAction" }], ME)).toBe(false);
    expect(hasDeclinedInvitation([{ email: ME, responseStatus: "accepted" }], ME)).toBe(false);
  });

  it("il rifiuto di QUALCUN ALTRO non è il tuo", () => {
    expect(
      hasDeclinedInvitation(
        [
          { email: "cliente@acme.test", responseStatus: "declined" },
          { email: ME, responseStatus: "accepted" },
        ],
        ME,
      ),
    ).toBe(false);
  });
});
