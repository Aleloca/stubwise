import { person } from "./helpers";

// Il giudizio di Claude «serve una mia risposta?» sul seme (area 8, «Clienti
// in attesa»), per `<email della casella>|<id dell'ultimo messaggio>`: due
// «sì» col motivo, un «no» (la conversazione si chiude da sé); gli altri
// thread che aspettano restano «da valutare».
export const SEED_REPLY_JUDGMENTS: [string, { judgment: "yes" | "no"; reason: string | null }][] = [
  [
    `${person("p-giulia").email}|mm-aud-billing-vat`,
    {
      judgment: "yes",
      reason:
        "They need the VAT number column in the billing export by Monday, and nobody has said whether it's coming.",
    },
  ],
  [
    `${person("p-giulia").email}|mm-stw-release-notes-date`,
    // «Wording approved, publish on 30 October»: un'informazione, nessuna domanda.
    { judgment: "no", reason: null },
  ],
  [
    `${person("p-matteo").email}|mm-aud-callbacks-monday`,
    {
      judgment: "yes",
      reason:
        "The callbacks are still an hour off on Monday mornings and they ask when it will be fixed.",
    },
  ],
];
