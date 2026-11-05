import type { SupportConversation, SupportMessage } from "../../types";
import { daysFromToday } from "../dates";

// Le conversazioni di Support di ACQ (area 8a, spec «Dati finti»). Nascono
// solo dai canali col triage: il widget e il server MCP, MAI da un'email.
//
// - ACQ-S1: dal widget, il triage è ancora in corso.
// - ACQ-S2: dal widget, la richiesta è aperta e il cliente ha riscritto:
//   aspetta una nostra risposta, con la bozza di Claude pronta.
// - ACQ-S3: dal widget, il cliente se n'è andato prima della fine del triage:
//   non conclusa, nessuna richiesta.
// - ACQ-S4: dal server MCP, la richiesta è nata con la conversazione allegata.
// - ACQ-S5, ACQ-S6: dal widget, le due richieste in coda (area 10b).
// - ACQ-S7: dal widget, aspetta una nostra risposta SENZA bozza di Claude.

/** Le richieste nate da una conversazione (in `requests.ts`, con `origin`). */
export const SUPPORT_REQUEST_IDS = {
  waiting: "req-acq-1",
  mcp: "req-acq-2",
  // Area 10b: le due richieste in coda, `high` (convertita in task) e `low`.
  reminder: "req-acq-3",
  dark: "req-acq-4",
  // 5 nov 2026: quella di ACQ-S7, che aspetta noi senza bozza.
  billingEmail: "req-acq-5",
} as const;

export const SUPPORT_CONVERSATION_IDS = {
  triage: "sup-acq-1",
  waiting: "sup-acq-2",
  left: "sup-acq-3",
  mcp: "sup-acq-4",
  reminder: "sup-acq-5",
  dark: "sup-acq-6",
  billingEmail: "sup-acq-7",
} as const;

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

type Row = [from: SupportMessage["from"], authorId: string | null, body: string, at: string];

const messages = (conversationId: string, rows: Row[]): SupportMessage[] =>
  rows.map(([from, authorId, body, when], i) => ({
    id: `${conversationId}-m${i + 1}`,
    from,
    authorId,
    body,
    at: when,
  }));

export const SUPPORT_CONVERSATIONS: SupportConversation[] = [
  {
    id: SUPPORT_CONVERSATION_IDS.triage,
    code: "ACQ-S1",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Giovanni Ferraro", email: "g.ferraro@example.com" },
    messages: messages(SUPPORT_CONVERSATION_IDS.triage, [
      [
        "customer",
        null,
        "The meter reading I sent last week is not on my account.",
        at(0, "09:40"),
      ],
      ["triage", null, "Thanks. Did you send it from the portal or from the app?", at(0, "09:41")],
      ["customer", null, "From the portal, with a photo of the meter.", at(0, "09:44")],
    ]),
    rewrittenWish: null,
    requestId: null,
    leftAt: null,
    confirmedAt: null,
    followerIds: [],
    claudeDraft: null,
  },
  {
    id: SUPPORT_CONVERSATION_IDS.waiting,
    code: "ACQ-S2",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Lucia Benedetti", email: "lucia.benedetti@example.com" },
    messages: messages(SUPPORT_CONVERSATION_IDS.waiting, [
      [
        "customer",
        null,
        "Can I pay the water bill in instalments from the portal?",
        at(4, "10:05"),
      ],
      [
        "triage",
        null,
        "Today the portal takes the whole amount. Would you like to split every bill, or only the larger ones?",
        at(4, "10:06"),
      ],
      ["customer", null, "Only the larger ones, like the yearly adjustment.", at(4, "10:09")],
      [
        "triage",
        null,
        "Got it: I passed your request to the team. You'll find the answer here.",
        at(4, "10:10"),
      ],
      [
        "team",
        "p-laura",
        "Thanks Lucia, we're looking into it with the billing office.",
        at(2, "15:20"),
      ],
      ["customer", null, "Any news? The yearly adjustment arrives next month.", at(0, "08:15")],
    ]),
    rewrittenWish:
      "Pay the larger bills (like the yearly adjustment) in instalments from the customer portal.",
    requestId: SUPPORT_REQUEST_IDS.waiting,
    leftAt: null,
    confirmedAt: at(4, "10:09"),
    followerIds: ["p-laura"],
    claudeDraft:
      "Hi Lucia, the request is with the team and the billing office is checking which bills can be split. We'll write here as soon as there is a decision, before the yearly adjustment arrives.",
  },
  {
    id: SUPPORT_CONVERSATION_IDS.left,
    code: "ACQ-S3",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Visitor", email: null },
    messages: messages(SUPPORT_CONVERSATION_IDS.left, [
      ["customer", null, "The portal logs me out all the time.", at(1, "18:02")],
      [
        "triage",
        null,
        "I'm sorry. Does it happen on a phone or on a computer, and after how long?",
        at(1, "18:03"),
      ],
    ]),
    rewrittenWish: null,
    requestId: null,
    leftAt: at(1, "18:20"),
    confirmedAt: null,
    followerIds: [],
    claudeDraft: null,
  },
  {
    id: SUPPORT_CONVERSATION_IDS.mcp,
    code: "ACQ-S4",
    projectId: "prj-acq",
    channel: "mcp",
    widgetId: null,
    customer: { name: "Technical office, Comune di Valfonda", email: null },
    messages: messages(SUPPORT_CONVERSATION_IDS.mcp, [
      [
        "customer",
        null,
        "We need the consumption history of the town buildings as a spreadsheet.",
        at(2, "10:30"),
      ],
      [
        "triage",
        null,
        "For which period, and one file per building or all together?",
        at(2, "10:31"),
      ],
      ["customer", null, "The last two years, all buildings in one file.", at(2, "10:35")],
      [
        "triage",
        null,
        "Thanks: the request is registered and the team will follow it from here.",
        at(2, "10:36"),
      ],
    ]),
    rewrittenWish:
      "Download the consumption history of the last two years for all the town buildings, in one spreadsheet.",
    requestId: SUPPORT_REQUEST_IDS.mcp,
    leftAt: null,
    confirmedAt: at(2, "10:35"),
    followerIds: [],
    claudeDraft: null,
  },
  // Area 10b: ACQ-S5 e ACQ-S6, da cui nascono le due richieste in coda.
  {
    id: SUPPORT_CONVERSATION_IDS.reminder,
    code: "ACQ-S5",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Paola Marchetti", email: "paola.marchetti@example.com" },
    messages: messages(SUPPORT_CONVERSATION_IDS.reminder, [
      ["customer", null, "I keep missing the due date of the water bill.", at(3, "09:12")],
      [
        "triage",
        null,
        "I'm sorry. Would a text message a few days before the due date help?",
        at(3, "09:13"),
      ],
      ["customer", null, "Yes, that would be perfect.", at(3, "09:16")],
      [
        "triage",
        null,
        "Got it: I passed your request to the team. You'll find the answer here.",
        at(3, "09:17"),
      ],
    ]),
    rewrittenWish: "Get a text message a few days before the water bill is due.",
    requestId: SUPPORT_REQUEST_IDS.reminder,
    leftAt: null,
    confirmedAt: at(3, "09:16"),
    followerIds: [],
    claudeDraft: null,
  },
  {
    id: SUPPORT_CONVERSATION_IDS.dark,
    code: "ACQ-S6",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Renato Gallo", email: "renato.gallo@example.com" },
    messages: messages(SUPPORT_CONVERSATION_IDS.dark, [
      [
        "customer",
        null,
        "The portal is very bright when I check it in the evening.",
        at(1, "08:40"),
      ],
      ["triage", null, "Would a dark appearance for the portal be what you need?", at(1, "08:41")],
      ["customer", null, "Yes, a dark one. Not urgent.", at(1, "08:44")],
      [
        "triage",
        null,
        "Thanks: the request is registered and the team will follow it from here.",
        at(1, "08:45"),
      ],
    ]),
    rewrittenWish: "A dark appearance for the customer portal.",
    requestId: SUPPORT_REQUEST_IDS.dark,
    leftAt: null,
    confirmedAt: at(1, "08:44"),
    followerIds: [],
    claudeDraft: null,
  },
  // 5 nov 2026: la seconda che aspetta noi, SENZA bozza di Claude. Con la
  // bozza pronta la riga «Claude can help you write the reply» non compare
  // (maintainer, 5 nov 2026), quindi ACQ-S2 non la mostra mai: è qui che si
  // vede. Davide ha già risposto una volta, il cliente ha riscritto.
  {
    id: SUPPORT_CONVERSATION_IDS.billingEmail,
    code: "ACQ-S7",
    projectId: "prj-acq",
    channel: "widget",
    widgetId: "wdg-acq-portal",
    customer: { name: "Marta Colombo", email: "marta.colombo@example.com" },
    messages: messages(SUPPORT_CONVERSATION_IDS.billingEmail, [
      [
        "customer",
        null,
        "My bills still go to my old email address, and I can't change it from the portal.",
        at(6, "09:20"),
      ],
      [
        "triage",
        null,
        "Would you like to change it yourself from the portal, or should the team change it for you this time?",
        at(6, "09:21"),
      ],
      ["customer", null, "From the portal, so I can change it again myself.", at(6, "09:25")],
      [
        "triage",
        null,
        "Got it: I passed your request to the team. You'll find the answer here.",
        at(6, "09:26"),
      ],
      [
        "team",
        "p-davide",
        "Thanks Marta, for now we changed it for you: the next bill goes to the new address.",
        at(5, "14:10"),
      ],
      [
        "customer",
        null,
        "Thank you! Will I be able to change it from the portal myself next time?",
        at(0, "09:05"),
      ],
    ]),
    rewrittenWish: "Change the email address that receives the bills from the customer portal.",
    requestId: SUPPORT_REQUEST_IDS.billingEmail,
    leftAt: null,
    confirmedAt: at(6, "09:25"),
    followerIds: ["p-davide"],
    claudeDraft: null,
  },
];
