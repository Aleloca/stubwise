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

/** Le richieste nate da una conversazione (in `requests.ts`, con `origin`). */
export const SUPPORT_REQUEST_IDS = { waiting: "req-acq-1", mcp: "req-acq-2" } as const;

export const SUPPORT_CONVERSATION_IDS = {
  triage: "sup-acq-1",
  waiting: "sup-acq-2",
  left: "sup-acq-3",
  mcp: "sup-acq-4",
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
    followerIds: [],
    claudeDraft: null,
  },
];
