import type { ChatMessage } from "../../types";
import {
  at,
  channelFlow,
  doc,
  done,
  file,
  repoFile,
  request,
  says,
  say,
  sys,
  task,
  type Spec,
} from "./helpers";

// Audin 2.0: il «general» (lancio, import, fatturazione: con l'unica
// chiamata a @Claude del seme che porta una proposta), «releases» (pagine
// di Release e PR) e il privato «pricing».

const general: Spec[] = [
  say(
    "p-laura",
    at(27, "09:10"),
    "Welcome to the Audin 2.0 channel. The launch plan and its owners are in AUD-2; ask here for anything that doesn't fit a task.",
    { cites: [task("t-aud-2")], react: [["👋", ["p-marco", "p-alessia", "p-stefano", "p-elena"]]] },
  ),
  say(
    "p-matteo",
    at(26, "14:05"),
    "Pricing tiers draft is in AUD-1: three tiers, the middle one with the dialer. Comments by Friday please.",
    {
      cites: [task("t-aud-1")],
      replies: [
        say(
          "p-giulia",
          at(26, "15:20"),
          "Can we call the middle one *Team* instead of *Pro*? Pro sounds like a separate product.",
        ),
        say("p-matteo", at(26, "15:41"), "Fine for me, updating it.", {
          react: [["👍", ["p-giulia"]]],
        }),
        say("p-laura", at(25, "09:02"), "+1 on Team."),
      ],
    },
  ),
  say(
    "p-alessia",
    at(21, "10:30"),
    "Large accounts report 14 s on the dashboard. I opened AUD-6 with the widget report attached.",
    {
      cites: [task("t-aud-6")],
      files: [file("att-aud-dash", "dashboard-load-large-account.png", 482_113)],
      react: [["😬", ["p-marco", "p-laura"]]],
      replies: [
        say(
          "p-marco",
          at(21, "11:02"),
          "Is it the activity widget again? Last time it was the unindexed query on calls.",
        ),
        say("p-alessia", at(21, "11:15"), "Profiling it tomorrow, I'll post the numbers here."),
        say(
          "p-alessia",
          at(20, "16:48"),
          "Numbers: 9.8 s in the calls query, 3 s rendering the activity list. Index first, then pagination.",
          { also: true, react: [["🙏", ["p-laura", "p-marco"]]] },
        ),
      ],
    },
  ),
  say(
    "p-laura",
    at(17, "16:00"),
    "For the import (AUD-3): we match duplicates by email first, then by phone. The rule is written in the docs.",
    { cites: [task("t-aud-3"), doc("doc-aud-import")] },
  ),
  say(
    "p-matteo",
    at(12, "09:40"),
    "AUD-R1 is converted: the call history export is now AUD-5, on Stefano.",
    { cites: [request("req-aud-1"), task("t-aud-5")], react: [["👍", ["p-stefano"]]] },
  ),
  sys(
    at(11, "07:00"),
    "brief_ready",
    { kind: "brief", id: "brief-aud-2026-10-12" },
    "Weekly brief ready",
  ),
  sys(
    at(9, "17:00"),
    "milestone_reached",
    { kind: "milestone", id: "ms-aud-1" },
    "Milestone reached: Private beta",
  ),
  say("p-laura", at(9, "17:12"), "Private beta closed on time. Thanks everyone!", {
    react: [
      ["🎉", ["p-marco", "p-alessia", "p-stefano", "p-matteo", "p-elena", "p-giulia"]],
      ["❤️", ["p-matteo"]],
    ],
  }),
  sys(
    at(6, "11:00"),
    "request_new",
    request("req-aud-2"),
    "New request: Callback reminders by email",
  ),
  say(
    "p-alessia",
    at(6, "11:25"),
    "I opened AUD-R2 after three operators asked the same thing in support this week.",
    { cites: [request("req-aud-2")] },
  ),
  say("p-laura", at(5, "10:02"), "", { deleted: { at: at(5, "10:03"), by: "p-laura" } }),
  sys(
    at(4, "07:00"),
    "brief_ready",
    { kind: "brief", id: "brief-aud-2026-10-19" },
    "Weekly brief ready",
  ),
  say(
    "p-laura",
    at(4, "08:30"),
    "The brief is right about the dashboard. @Alessia Neri can you give AUD-6 an owner check this week?",
    {
      cites: [task("t-aud-6")],
      asks: ["p-alessia"],
      replies: [
        say(
          "p-alessia",
          at(4, "09:10"),
          "Yes. I'll split it in two: the query fix and the caching.",
        ),
      ],
    },
  ),
  say(
    "p-marco",
    at(3, "15:30"),
    "The timezone fix for callbacks is merged and AUD-9 is closed. Callbacks scheduled before the fix keep their old time: we don't rewrite them.",
    {
      cites: [task("t-aud-9"), doc("doc-aud-callbacks")],
      edited: at(3, "15:34"),
      react: [["🙌", ["p-laura", "p-alessia"]]],
    },
  ),
  say(
    "p-stefano",
    at(2, "11:00"),
    "Export is moving: the columns are done, the download button is next. Claude is on the background job.",
    { cites: [task("t-aud-5"), repoFile("audin-app:src/calls/export-job.ts")] },
  ),
  say(
    "p-elena",
    at(1, "16:45"),
    "Draft of the launch announcement for existing customers is in AUD-8. @Laura Costa do we mention the new pricing, or keep it for the second email?",
    { cites: [task("t-aud-8")], asks: ["p-laura"] },
  ),
  say(
    "p-marco",
    at(0, "09:20"),
    "Billing emails (AUD-4): should the invoice PDF be attached or linked? The docs say attached, the old flow links it.",
    {
      cites: [task("t-aud-4"), doc("doc-aud-billing")],
      replies: [
        say("p-matteo", at(0, "09:31"), "Attached. Customers forward it to their accountant."),
        say(
          "p-marco",
          at(0, "09:40"),
          "@Claude create a task to keep the invoice PDF attachment under 2 MB, for Stefano next week.",
        ),
        {
          by: "claude",
          at: at(0, "09:41"),
          text: "The billing page says the invoice PDF is attached to the billing email, so a size check makes sense. I can add the task in AUD for Stefano Amato in week 44: confirm below.",
          cites: [doc("doc-aud-billing"), task("t-aud-4")],
          claude: {
            calledBy: "p-marco",
            events: [
              done(at(0, "09:41"), "read_task", "Read AUD-4", {
                result: "Billing emails with the new invoice layout",
              }),
              done(at(0, "09:41"), "search_docs", "Searched the AUD docs", {
                input: "invoice PDF attachment",
                result: "Invoices and billing emails",
              }),
              says(
                at(0, "09:41"),
                "The billing page says the invoice PDF is attached to the billing email, so a size check makes sense. I can add the task in AUD for Stefano Amato in week 44: confirm below.",
              ),
              {
                at: at(0, "09:41"),
                type: "proposal",
                proposalId: "prop-chat-aud-pdf-1",
                requesterId: "p-marco",
                actions: [
                  {
                    fn: "createTask",
                    args: {
                      projectId: "prj-aud",
                      title: "Keep the invoice PDF attachment under 2 MB",
                      assigneeId: "p-stefano",
                      plannedWeek: "2026-W44",
                    },
                    summary:
                      "Create in AUD: “Keep the invoice PDF attachment under 2 MB” · Stefano Amato · W44",
                  },
                ],
                status: "open",
              },
            ],
          },
        },
      ],
    },
  ),
  say(
    "p-alessia",
    at(0, "10:05"),
    "@channel heads-up: staging is redeployed at 13:00 for the dashboard fix, about ten minutes.",
    { react: [["👍", ["p-marco", "p-stefano"]]] },
  ),
  say(
    "p-giulia",
    at(0, "11:30"),
    "@Marco Bellini when the billing emails are ready, can I see a preview? I want the announcement copy to match.",
    { asks: ["p-marco"] },
  ),
];

const releases: Spec[] = [
  sys(at(17, "11:30"), "pr_opened", task("t-aud-12"), "PR #214 opened on audin/audin-app"),
  sys(at(15, "12:30"), "pr_merged", task("t-aud-12"), "PR #214 merged on audin/audin-app"),
  say("p-laura", at(15, "12:41"), "Legacy SMS is gone, settings page included. 🧹", {
    react: [["🧹", ["p-marco", "p-stefano"]]],
  }),
  sys(
    at(9, "16:40"),
    "release_page",
    { kind: "release", id: "rel-aud-1" },
    "Release page: 0.9.0 Private beta",
  ),
  say(
    "p-laura",
    at(9, "16:52"),
    "Release notes for 0.9 are up. @Matteo Conti anything to add for the sales deck?",
    {
      asks: ["p-matteo"],
      replies: [say("p-matteo", at(9, "17:30"), "No, all good. I'll link the page in the deck.")],
    },
  ),
  sys(
    at(2, "17:05"),
    "release_page",
    { kind: "release", id: "rel-aud-2" },
    "Release page: 0.10.0 Callbacks and import preview",
  ),
  say(
    "p-marco",
    at(2, "17:20"),
    "Note for 0.10: the import preview is in, but only behind the flag until AUD-3 is answered.",
    { cites: [task("t-aud-3")] },
  ),
];

const pricing: Spec[] = [
  say(
    "p-matteo",
    at(20, "10:15"),
    "Discount ladder for annual plans. Let's keep it here until we agree.",
    {
      files: [file("att-aud-pricing", "pricing-annual-v3.xlsx", 38_400)],
      replies: [
        say("p-laura", at(20, "11:02"), "15% on annual is fine. 25% is too much for the launch."),
        say("p-elena", at(20, "11:40"), "Agree with Laura. Sales can still offer it case by case."),
      ],
    },
  ),
  say("p-matteo", at(3, "09:05"), "Final numbers are in AUD-1. I'm closing this discussion.", {
    cites: [task("t-aud-1")],
    react: [["✅", ["p-laura", "p-elena"]]],
  }),
];

export const AUD_MESSAGES: ChatMessage[] = [
  ...channelFlow("ch-aud-general", general),
  ...channelFlow("ch-aud-releases", releases),
  ...channelFlow("ch-aud-pricing", pricing),
];
