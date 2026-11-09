import type { MailMessage } from "../../types";
import { ACQ_11B } from "../productDocs/facts";
import { at, ext, mail, person } from "./helpers";

// La posta «in arrivo»: non è ancora in nessuna casella. La porta dentro il
// primo «Aggiorna ora» della casella che la contiene (`syncMailbox`), che la
// manda al modello se la casella ha le proposte attive. È datata fra
// l'ultimo allineamento della casella (11:58) e «adesso» (12:00): è arrivata
// su Gmail mentre Stubwise non guardava.

export const INCOMING_MESSAGE_ID = "mm-aud-dialer-acceptance";

export const MAIL_INCOMING: MailMessage[] = [
  mail({
    id: INCOMING_MESSAGE_ID,
    messageId: "<dialer-acceptance.20261025@audin.example>",
    threadId: "th-aud-dialer-acceptance",
    from: ext("Sofia Marchetti", "sofia.marchetti@audin.example"),
    to: [person("p-giulia")],
    subject: "Dialer acceptance tests: can we start tomorrow?",
    at: at(0, "11:59"),
    text: "Hi Giulia,\n\nLaura told us the dialer is ready. Can we start the acceptance tests tomorrow morning? Please send the checklist.\n\nSofia",
    mailboxPersonIds: ["p-giulia"],
    // La decide l'arrivo: `pending` o `off` secondo la casella.
    classification: { state: "pending" },
  }),
  // Area 11b: due email di ACQ nella casella di Matteo (quella di Laura è
  // scaduta). Arrivate e classificate in ACQ, sono fonti della doc di
  // prodotto: la prima dice chiaro «fino a tre foto» (Claude aggiorna
  // Features per conto di Matteo), la seconda è l'email di Gemini della
  // riunione di ieri, organizzata da Laura (un «forse», quindi una domanda,
  // e un passo che non c'è più nella pagina).
  mail({
    id: ACQ_11B.incomingEmailId,
    messageId: "<fault-photo-limit.20261023@acquedottocolline.example>",
    threadId: "th-acq-fault-photo-limit",
    from: ext("Elisa Ferraro", "elisa.ferraro@acquedottocolline.example"),
    to: [person("p-matteo"), person("p-laura")],
    subject: "Fault reports: up to three photos",
    at: at(0, "11:59"),
    text: "Hi Matteo,\n\nwe agreed internally: a fault report on the Acquedotto portal can have up to three photos.\n\nElisa",
    mailboxPersonIds: ["p-matteo"],
    classification: { state: "pending" },
  }),
  mail({
    id: ACQ_11B.incomingMeetingId,
    messageId: "<notes-acq-weekly-check.20261022@google.com>",
    threadId: "th-gemini-acq-weekly",
    from: ext("Gemini", "gemini-notes@google.com"),
    to: [person("p-laura"), person("p-matteo")],
    subject: "Notes: “Weekly check with Acquedotto delle Colline”",
    at: at(0, "11:59"),
    text: "Meeting notes for “Weekly check with Acquedotto delle Colline” are ready. Open the notes in Google Docs to see the summary, the next steps and the transcript.",
    kind: "transcript",
    mailboxPersonIds: ["p-matteo"],
    classification: { state: "pending" },
  }),
];
