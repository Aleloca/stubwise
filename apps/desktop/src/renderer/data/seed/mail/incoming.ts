import type { MailMessage } from "../../types";
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
];
