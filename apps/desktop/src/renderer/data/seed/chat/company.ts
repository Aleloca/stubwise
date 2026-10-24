import type { ChatMessage } from "../../types";
import { at, channelFlow, file, project, request, say, type Spec } from "./helpers";

// I canali generali dell'azienda («announcements», «marketing»,
// «chit-chat») e un paio di «general» di progetti clienti, con poco.

const announcements: Spec[] = [
  say(
    "p-roberta",
    at(27, "08:30"),
    "From today we chat here instead of Slack. On the free plan Slack deleted everything older than 90 days: here nothing expires.",
    {
      react: [
        ["🎉", ["p-giulia", "p-marco", "p-laura", "p-sara", "p-federico", "p-matteo", "p-elena"]],
        ["👍", ["p-davide", "p-paolo", "p-giorgio"]],
      ],
    },
  ),
  say("p-roberta", at(20, "12:00"), "The office is closed on Monday, November 2nd."),
  say(
    "p-giorgio",
    at(13, "09:00"),
    "New expense policy attached: receipts within 30 days of the expense, please.",
    { files: [file("att-gen-expenses", "expense-policy-2026.pdf", 312_448)] },
  ),
  say(
    "p-roberta",
    at(6, "09:15"),
    "@channel Q4 all-hands next Thursday at 10:00. Agenda: the Audin launch, the Stubwise desktop app, client renewals.",
    {
      // In un canale di tutti: chi non vede AUD legge il codice sbiadito (R-E9).
      cites: [project("prj-aud"), project("prj-stw")],
      react: [["👍", ["p-laura", "p-matteo", "p-giulia", "p-sara"]]],
    },
  ),
  say("p-roberta", at(0, "08:30"), "Reminder: timesheets by the end of the day."),
];

const marketing: Spec[] = [
  say("p-giulia", at(24, "11:00"), "Brand guidelines updated: new colour values for print.", {
    files: [file("att-mkt-guidelines", "brand-guidelines-2026.pdf", 4_802_115)],
  }),
  say("p-elena", at(10, "15:30"), "Newsletter calendar for November, across clients:", {
    files: [file("att-mkt-newsletters", "newsletter-calendar-november.xlsx", 22_910)],
    replies: [
      say(
        "p-paolo",
        at(10, "15:52"),
        "VDM goes on the 4th, not the 2nd: their tasting is on the 3rd.",
      ),
      say("p-elena", at(10, "16:05"), "Fixed, thanks."),
    ],
  }),
  say("p-paolo", at(2, "10:00"), "Trade press deadline for the December issues is the 30th."),
];

const chitChat: Spec[] = [
  say("p-federico", at(23, "13:10"), "The coffee machine on the second floor works again ☕", {
    react: [
      ["☕", ["p-marco", "p-laura", "p-simone", "p-sara", "p-davide", "p-alessia", "p-stefano"]],
      ["🙏", ["p-giulia"]],
      ["🎉", ["p-elena", "p-paolo"]],
    ],
  }),
  say("p-marta", at(16, "11:30"), "Who's up for lunch at the new place on Thursday?", {
    replies: [
      say("p-sara", at(16, "11:41"), "Me!"),
      say("p-davide", at(16, "11:45"), "Me too."),
      say("p-nicola", at(16, "12:10"), "Count me in, 12:30?"),
      say("p-marta", at(16, "12:12"), "12:30 it is. Table for four."),
    ],
  }),
  say("p-simone", at(5, "09:00"), "From Sunday's hike, the lake from above.", {
    files: [file("att-cc-hike", "lake-from-above.jpg", 3_404_221)],
    react: [["😍", ["p-sara", "p-marta", "p-giulia"]]],
  }),
  say("p-davide", at(1, "15:30"), "Cake in the kitchen 🎂", {
    react: [["🎂", ["p-sara", "p-marta", "p-nicola", "p-federico"]]],
  }),
  say("p-sara", at(0, "11:50"), "@Roberta Fontana are we doing the secret santa again this year?", {
    asks: ["p-roberta"],
  }),
];

const olvGeneral: Spec[] = [
  say(
    "p-giulia",
    at(3, "12:00"),
    "OLV-R1: the client wants new photos of the olive grove on the homepage before the harvest.",
    { cites: [request("req-olv-1")] },
  ),
];

export const COMPANY_MESSAGES: ChatMessage[] = [
  ...channelFlow("ch-announcements", announcements),
  ...channelFlow("ch-marketing", marketing),
  ...channelFlow("ch-chit-chat", chitChat),
  ...channelFlow("ch-olv-general", olvGeneral),
];
