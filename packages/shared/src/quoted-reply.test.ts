import { describe, expect, it } from "vitest";
import { splitQuotedReply } from "./quoted-reply.js";

/** Le forme sono quelle viste in produzione il 29 set 2026, con i nomi cambiati. */
describe("splitQuotedReply", () => {
  it("risposta Outlook: dalla riga di separazione in giù è citazione", () => {
    const text = [
      "Buongiorno,",
      "confermo la modifica.",
      "",
      "Mario Rossi",
      "________________________________",
      "Da: Ufficio IT <it@example.com>",
      "Inviato: martedì 28 luglio 2026 12:11",
      "A: Cliente <cliente@example.com>",
      "Oggetto: Re: APP 4.0 gestione trattamenti",
      "",
      "Il testo della mail precedente",
    ].join("\n");

    const split = splitQuotedReply(text);
    expect(split.body).toBe("Buongiorno,\nconfermo la modifica.\n\nMario Rossi");
    expect(split.quoted).toMatch(/^_{10,}\nDa: Ufficio IT/);
    expect(split.quoted).toMatch(/Il testo della mail precedente$/);
  });

  it("anche senza separatore, e in inglese", () => {
    const split = splitQuotedReply("Ok, thanks\n\nFrom: Bob <bob@example.com>\nSent: Monday\nTo: Me\nSubject: Re: x\n\nold");
    expect(split.body).toBe("Ok, thanks");
    expect(split.quoted).toMatch(/^From: Bob/);
  });

  it("si taglia alla PRIMA intestazione, con tutta la catena dentro la citazione", () => {
    const split = splitQuotedReply("Nuovo\nDa: A\nInviato: 1\nOggetto: R: x\nvecchio\nDa: B\nInviato: 2\nOggetto: Re: x\npiù vecchio");
    expect(split.body).toBe("Nuovo");
    expect(split.quoted).toMatch(/più vecchio$/);
  });

  it("un inoltro di Gmail NON si taglia: il testo sotto è il contenuto", () => {
    const text = [
      "Vi giro questa",
      "---------- Forwarded message ---------",
      "Da: Sales <sales@example.com>",
      "Date: lun 14 set 2026 alle ore 10:05",
      "Subject: Fwd: Anomalie sconti su Bundle",
      "To: Team <team@example.com>",
      "",
      "Il contenuto inoltrato",
    ].join("\n");
    expect(splitQuotedReply(text)).toEqual({ body: text, quoted: null });
  });

  it("un blocco Da:/Date: (forma Gmail) non è una risposta Outlook", () => {
    const text = "Testo\nDa: X <x@example.com>\nDate: lun 14 set\nSubject: y\n\ncontenuto";
    expect(splitQuotedReply(text).quoted).toBeNull();
  });

  it("un inoltro di Outlook (oggetto «I:» o «Fw:») NON si taglia", () => {
    for (const prefix of ["I:", "Fw:", "FWD:", "Tr:"]) {
      const text = `Vedi sotto\n________________________________\nDa: X\nInviato: ieri\nOggetto: ${prefix} preventivo\n\ncontenuto`;
      expect(splitQuotedReply(text).quoted).toBeNull();
    }
  });

  it("un messaggio che è SOLO citazione resta intero", () => {
    const text = "Da: X\nInviato: ieri\nOggetto: Re: y\n\ncontenuto";
    expect(splitQuotedReply(text)).toEqual({ body: text, quoted: null });
  });

  it("un «Da:» nel testo senza «Inviato:» accanto non taglia niente", () => {
    const text = "Da: lunedì siamo operativi\nA presto";
    expect(splitQuotedReply(text).quoted).toBeNull();
  });

  it("nessuna intestazione: corpo intero, niente citazione", () => {
    expect(splitQuotedReply("Solo testo")).toEqual({ body: "Solo testo", quoted: null });
  });
});
