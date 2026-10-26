import type { MailMessage } from "../../types";
import { daysFromToday } from "../dates";
import { at, done, ext, mail, person } from "./helpers";

// La posta di progetto e il rumore: email su AUD e STW di importanza alta,
// normale e bassa (con scadenze), newsletter e una personale senza
// progetto, una incerta fra AUD e MKX, una in analisi e una fallita. Le
// email di Gemini e i contenuti estremi stanno in `meetings.ts` e
// `extremes.ts`. La casella di Laura è ferma da 5 giorni: contiene solo
// posta di prima.

const AUD = "prj-aud";
const STW = "prj-stw";
const MKX = "prj-mkx";

const GIULIA = person("p-giulia");
const MATTEO = person("p-matteo");
const LAURA = person("p-laura");
const SIMONE = person("p-simone");
const SOFIA = ext("Sofia Marchetti", "sofia.marchetti@audin.example");
const IVO = ext("Ivo Gentile", "ivo@pixelforge.example");

/** Gli id delle righe che i test e le aree successive cercano per caso. */
export const MESSAGE_IDS = {
  shared: "mm-aud-billing-vat",
  confirmed: "mm-aud-callbacks-monday",
  audLow: "mm-aud-call-notes",
  stwHigh: "mm-stw-copy-freeze",
  handed: "mm-stw-release-notes-date",
  newsletter1: "mm-news-smashing",
  newsletter2: "mm-news-product-weekly",
  personal: "mm-personal-dinner",
  uncertain: "mm-video-testimonials",
  pending: "mm-aud-dialer-pricing",
  failed: "mm-mkx-order-confirmation",
  lauraOff: "mm-stw-pr-review",
  context: "mm-stw-preview-schedule",
} as const;

export const PROJECT_MESSAGES: MailMessage[] = [
  // La condivisa: a Giulia e Matteo, Laura in copia, arrivata nelle tre
  // caselle prima che quella di Laura scadesse. Una sola proposta aperta.
  mail({
    id: MESSAGE_IDS.shared,
    messageId: "<billing-vat.20261017@audin.example>",
    threadId: "th-aud-billing-vat",
    from: SOFIA,
    to: [GIULIA, MATTEO],
    cc: [LAURA],
    subject: "Billing export: we need the VAT number column by Monday",
    at: at(6, "09:20"),
    text: [
      "Hi both,",
      "our accountant can't reconcile the monthly billing export without the customer's VAT number. Could you add a VAT number column to the CSV export? We need it for the close on Monday 26 October.",
      "Thanks,\nSofia",
    ].join("\n\n"),
    attachments: [
      { id: "att-billing-sample", name: "billing-export-sample.csv", sizeBytes: 18_432 },
    ],
    mailboxPersonIds: ["p-giulia", "p-matteo", "p-laura"],
    readByPersonIds: ["p-matteo", "p-laura"],
    classification: done([AUD], "high", daysFromToday(3)),
  }),
  // Già confermata da Matteo: un commento sulla task dei callback.
  mail({
    id: MESSAGE_IDS.confirmed,
    messageId: "<callbacks-monday.20261021@audin.example>",
    threadId: "th-aud-callbacks",
    from: SOFIA,
    to: [MATTEO],
    cc: [GIULIA],
    subject: "Callbacks still an hour off on Monday mornings",
    at: at(2, "08:05"),
    text: "Hi Matteo,\n\nthe callbacks scheduled for Monday morning still fire one hour late for the Rome office. The other days look right. Can the team have a look?\n\nSofia",
    mailboxPersonIds: ["p-matteo", "p-giulia"],
    readByPersonIds: ["p-matteo", "p-giulia"],
    classification: done([AUD], "normal"),
  }),
  // AUD, importanza bassa: le note della chiamata, nessuna proposta.
  mail({
    id: MESSAGE_IDS.audLow,
    threadId: "th-aud-call-notes",
    from: MATTEO,
    to: [GIULIA],
    cc: [LAURA],
    subject: "Notes from today's client call are in the AUD folder",
    at: at(1, "10:30"),
    text: "Hi Giulia,\n\nI put the notes from this morning's call with Sofia in the AUD – Cliente folder. Nothing urgent, just for reference.\n\nMatteo",
    mailboxPersonIds: ["p-matteo", "p-giulia"],
    readByPersonIds: ["p-matteo"],
    classification: done([AUD], "low"),
  }),
  // Il messaggio di contesto della stessa conversazione: il calendario della
  // build che Laura aveva mandato martedì, citato nella sua email di oggi.
  // Stubwise non lo classifica da sé (`context`): nessuna proposta.
  mail({
    id: MESSAGE_IDS.context,
    threadId: "th-stw-copy-freeze",
    from: LAURA,
    to: [GIULIA],
    subject: "Desktop preview: copy freeze tomorrow",
    at: at(3, "16:40"),
    text: "Giulia,\n\ndraft schedule for the preview build attached. The copy freeze is the day before the build.\n\nLaura",
    mailboxPersonIds: ["p-giulia"],
    readByPersonIds: ["p-giulia"],
    context: true,
    // Letto solo come contesto dell'email di oggi: nessun progetto da sé.
    classification: done([], "normal"),
  }),
  // STW, alta, scadenza domani: una proposta aperta per Giulia.
  mail({
    id: MESSAGE_IDS.stwHigh,
    threadId: "th-stw-copy-freeze",
    from: LAURA,
    to: [GIULIA],
    subject: "Desktop preview: copy freeze tomorrow",
    at: at(0, "10:15"),
    text: "Giulia,\n\nwe freeze the copy of the desktop preview tomorrow at 17:00. Anything still open in the onboarding screens needs to land before then, otherwise it moves to the next build.\n\nLaura",
    quoted: "On Tue, Laura Costa wrote:\n> Draft schedule for the preview build attached.",
    mailboxPersonIds: ["p-giulia"],
    classification: done([STW], "high", daysFromToday(1)),
  }),
  // STW, normale: la data delle note di rilascio. Giulia è Contributor in
  // STW (niente `tickets.edit`): l'ha passata al progetto.
  mail({
    id: MESSAGE_IDS.handed,
    threadId: "th-stw-release-notes",
    from: IVO,
    to: [GIULIA],
    subject: "Release notes: wording approved, publish on 30 October",
    at: at(3, "14:50"),
    text: "Hi Giulia,\n\nthe wording of the release notes is approved on our side. We'd publish them together with the preview on 30 October rather than this week.\n\nBest,\nIvo",
    mailboxPersonIds: ["p-giulia"],
    readByPersonIds: ["p-giulia"],
    classification: done([STW], "normal", daysFromToday(7)),
  }),
  // Newsletter e personale: nessun progetto, nessuna proposta.
  mail({
    id: MESSAGE_IDS.newsletter1,
    threadId: "th-news-smashing",
    from: ext("Smashing Magazine", "newsletter@smashing.example"),
    to: [GIULIA],
    subject: "Smashing Newsletter #512: accessible colour palettes",
    at: at(0, "07:00"),
    text: "This week: building accessible colour palettes, a deep dive into container queries and five new workshops.",
    html: '<h1>Smashing Newsletter #512</h1><p>This week: <a href="https://smashing.example/palettes">accessible colour palettes</a>.</p>',
    mailboxPersonIds: ["p-giulia"],
    classification: done([], "low"),
  }),
  mail({
    id: MESSAGE_IDS.newsletter2,
    threadId: "th-news-product-weekly",
    from: ext("Product Weekly", "hello@productweekly.example"),
    to: [MATTEO],
    subject: "Product Weekly: pricing pages that convert",
    at: at(1, "06:30"),
    text: "Five pricing pages that convert, and what they have in common.",
    mailboxPersonIds: ["p-matteo"],
    classification: done([], "low"),
  }),
  mail({
    id: MESSAGE_IDS.personal,
    threadId: "th-personal-dinner",
    from: ext("Anna Ferri", "anna.ferri@familymail.example"),
    to: [GIULIA],
    subject: "Cena domenica?",
    at: at(0, "08:12"),
    text: "Ciao! Domenica sera siamo da noi, vieni anche tu? Porta il dolce se riesci :)",
    mailboxPersonIds: ["p-giulia"],
    classification: done([], "normal"),
  }),
  // Incerta fra AUD e MKX (Giulia e Matteo sono in entrambi): la proposta
  // «scegli il progetto» la semina il Task 3.
  mail({
    id: MESSAGE_IDS.uncertain,
    threadId: "th-video-testimonials",
    from: ext("Cristina Valli", "cristina@lucevideo.example"),
    to: [GIULIA, MATTEO],
    subject: "Video testimonials: dates for the shooting",
    at: at(1, "15:20"),
    text: "Hello,\n\nwe can shoot the customer testimonials on 4 or 5 November. Which campaign are they for, the product launch or the spring one? Let me know and I'll send the quote.\n\nCristina",
    mailboxPersonIds: ["p-giulia", "p-matteo"],
    readByPersonIds: ["p-giulia"],
    classification: done([], "normal", null, [AUD, MKX]),
  }),
  // In analisi: appena arrivata nella casella di Matteo.
  mail({
    id: MESSAGE_IDS.pending,
    threadId: "th-aud-dialer-pricing",
    from: SOFIA,
    to: [MATTEO],
    subject: "Quick question on the dialer pricing",
    at: at(0, "11:40"),
    text: "Matteo, is the dialer included in the base plan or billed per seat? The board asks before Thursday.",
    mailboxPersonIds: ["p-matteo"],
    classification: { state: "pending" },
  }),
  // Analisi fallita («Riproponi»).
  mail({
    id: MESSAGE_IDS.failed,
    threadId: "th-mkx-order",
    from: ext("Ufficio Acquisti Mix Cucine", "acquisti@mixcucine.example"),
    to: [MATTEO],
    subject: "Conferma d'ordine 2026/1187",
    at: at(0, "09:10"),
    text: "In allegato la conferma d'ordine per i listini dei rivenditori.",
    attachments: [{ id: "att-order-1187", name: "ordine-2026-1187.pdf", sizeBytes: 412_880 }],
    mailboxPersonIds: ["p-matteo"],
    classification: { state: "failed" },
  }),
  // Solo nella casella di Laura, con le proposte spente: non va al modello.
  mail({
    id: MESSAGE_IDS.lauraOff,
    threadId: "th-stw-pr-review",
    from: SIMONE,
    to: [LAURA],
    subject: "Can you review the board drag and drop PR before Friday?",
    at: at(6, "16:45"),
    text: "Hi Laura, the keyboard drag and drop for the board is ready for review. Could you have a look before Friday?\n\nSimone",
    mailboxPersonIds: ["p-laura"],
    readByPersonIds: ["p-laura"],
    classification: { state: "off" },
  }),
];
