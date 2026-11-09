import type { ChatMessage } from "../../types";
import { at, channelFlow, file, request, say, sys, task, type Spec } from "./helpers";

// Mix Cucine: il «general» (brief, listino, richieste del cliente),
// «grafica» (foto e impaginati, con una task nata da un messaggio) e il
// vecchio canale della campagna d'autunno, archiviato.

const general: Spec[] = [
  say(
    "p-giulia",
    at(28, "09:05"),
    "Mix Cucine spring campaign: brief, creatives, media plan. Client feedback goes in the tasks, not here, so we don't lose it.",
    { react: [["👍", ["p-paolo", "p-chiara", "p-elena"]]] },
  ),
  say("p-matteo", at(26, "10:00"), "The client wants the brief by the 10th (MKX-R1).", {
    cites: [request("req-mkx-1")],
  }),
  say("p-giulia", at(19, "16:30"), "Brief draft is in MKX-1. Second version attached.", {
    cites: [task("t-mkx-1")],
    files: [file("att-mkx-brief", "mix-cucine-spring-brief-v2.pdf", 1_204_331)],
    replies: [
      say(
        "p-paolo",
        at(19, "17:02"),
        "Budget split looks right. I'd move 10% from print to social.",
      ),
      say(
        "p-chiara",
        at(18, "09:15"),
        "The moodboard page needs the new kitchens, not last year's.",
      ),
      say("p-giulia", at(18, "10:00"), "Both done in v3.", {
        react: [["🙏", ["p-paolo", "p-chiara"]]],
      }),
    ],
  }),
  sys(at(9, "16:00"), "task_closed", task("t-mkx-1"), "Task closed: Spring campaign brief"),
  sys(
    at(8, "11:00"),
    "request_new",
    request("req-mkx-3"),
    "New request: Short video for the kitchens line",
  ),
  say(
    "p-giulia",
    at(6, "12:10"),
    "The price list for the dealers is waiting on Mix Cucine (MKX-5). I marked it as stalled.",
    { cites: [task("t-mkx-5")] },
  ),
  sys(
    at(4, "07:00"),
    "brief_ready",
    { kind: "brief", id: "brief-mkx-2026-10-19" },
    "Weekly brief ready",
  ),
  sys(at(4, "10:00"), "task_closed", task("t-mkx-10"), "Task closed: Leads report for the dealers"),
  sys(
    at(1, "11:00"),
    "request_new",
    request("req-mkx-2"),
    "New request: Landing page for the showroom event",
  ),
  say(
    "p-francesca",
    at(1, "11:20"),
    "The showroom landing page request is in. The date is fixed, so I set it high.",
    {
      cites: [request("req-mkx-2")],
      replies: [
        say("p-matteo", at(1, "11:45"), "@Giulia Ferri can we start the copy this week?", {
          asks: ["p-giulia"],
        }),
      ],
    },
  ),
  say("p-paolo", at(0, "09:00"), "Media plan for April: final version tomorrow (MKX-3).", {
    cites: [task("t-mkx-3")],
  }),
  say(
    "p-tommaso",
    at(0, "11:15"),
    "@Marketing who covers the showroom photos? MKX-8 has no owner yet.",
    { cites: [task("t-mkx-8")] },
  ),
];

const grafica: Spec[] = [
  say("p-chiara", at(22, "10:00"), "Three hero options for the kitchens line.", {
    files: [
      file("att-mkx-hero-a", "hero-a.jpg", 2_310_004),
      file("att-mkx-hero-b", "hero-b.jpg", 2_150_871),
      file("att-mkx-hero-c", "hero-c.jpg", 1_998_120),
    ],
    replies: [
      say("p-giulia", at(22, "10:20"), "B, but warmer."),
      say("p-elena", at(22, "10:31"), "B for me too."),
      say("p-chiara", at(22, "11:00"), "B warmer coming tomorrow."),
    ],
  }),
  say("p-chiara", at(21, "09:40"), "B, warmer.", {
    files: [file("att-mkx-hero-b2", "hero-b-warm.jpg", 2_201_556)],
    react: [["🔥", ["p-giulia", "p-elena", "p-tommaso"]]],
  }),
  say(
    "p-tommaso",
    at(3, "08:30"),
    "Banner sizes for the trade press: 300×250, 728×90, 160×600 and a print half page.",
    { linked: ["MKX-11"] },
  ),
  say("p-giulia", at(3, "15:00"), "@Chiara Lombardi is the hero final for the landing page?", {
    cites: [task("t-mkx-2")],
    asks: ["p-chiara"],
    replies: [say("p-chiara", at(1, "10:05"), "Final after the client's colour check on Monday.")],
  }),
  say(
    "p-chiara",
    at(0, "10:10"),
    "Logo lockup for the showroom invitation: which one? @Giulia Ferri",
    {
      files: [
        file("att-mkx-lockup-1", "lockup-1.png", 180_220),
        file("att-mkx-lockup-2", "lockup-2.png", 176_904),
      ],
      asks: ["p-giulia"],
    },
  ),
];

const autumn: Spec[] = [
  say(
    "p-paolo",
    at(45, "16:00"),
    "Final autumn creatives delivered (MKX-12). Archiving the channel.",
    {
      cites: [task("t-mkx-12")],
      react: [["👋", ["p-giulia", "p-elena"]]],
    },
  ),
];

export const MKX_MESSAGES: ChatMessage[] = [
  ...channelFlow("ch-mkx-general", general),
  ...channelFlow("ch-mkx-grafica", grafica),
  ...channelFlow("ch-mkx-autumn", autumn),
];
