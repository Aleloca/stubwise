import type { ChatMessage } from "../../types";
import {
  at,
  channelFlow,
  doc,
  done,
  repoFile,
  request,
  says,
  say,
  sys,
  task,
  type Spec,
} from "./helpers";

// Stubwise: il «general» (pianificazione, guida self-hosted, task ferme) e
// «desktop-app» (il prototipo, con le PR e una risposta di @Claude senza
// proposta).

const general: Spec[] = [
  say(
    "p-laura",
    at(27, "09:00"),
    "This is the Stubwise channel: planning, the desktop prototype and self-hosted. The weekly brief lands here on Mondays.",
    { react: [["👋", ["p-marco", "p-simone", "p-sara"]]] },
  ),
  sys(
    at(20, "09:00"),
    "milestone_reached",
    { kind: "milestone", id: "ms-stw-3" },
    "Milestone reached: Self-hosted 1.0",
  ),
  say(
    "p-davide",
    at(20, "10:20"),
    "The upgrade guide (STW-8) still needs the restart order: server before worker.",
    {
      cites: [task("t-stw-8"), doc("doc-stw-selfhost")],
      replies: [
        say(
          "p-laura",
          at(20, "10:41"),
          "Yes, migrations run when the server starts. @Davide Pellegrini can you add it this week?",
          { asks: ["p-davide"] },
        ),
        say("p-davide", at(20, "11:00"), "On it."),
        say(
          "p-davide",
          at(16, "17:30"),
          "It slipped again, sorry: the support queue ate the week.",
        ),
      ],
    },
  ),
  say(
    "p-sara",
    at(14, "14:10"),
    "Customers ask what *stalled* means in the task list. Should the help article explain it, or a tooltip?",
    {
      cites: [task("t-stw-6"), doc("doc-stw-stalled")],
      replies: [
        say(
          "p-elena",
          at(14, "14:32"),
          "Both: one line in the tooltip, the reasons in the article.",
        ),
        say("p-giulia", at(14, "15:05"), "Agree. The wording is in STW-4.", {
          cites: [task("t-stw-4")],
        }),
      ],
    },
  ),
  sys(
    at(11, "07:00"),
    "brief_ready",
    { kind: "brief", id: "brief-stw-2026-10-12" },
    "Weekly brief ready",
  ),
  say(
    "p-federico",
    at(6, "12:00"),
    "The focus ring fix in the notifications panel is out (STW-9).",
    {
      cites: [task("t-stw-9")],
      react: [
        ["👀", ["p-sara"]],
        ["✅", ["p-laura"]],
      ],
    },
  ),
  sys(
    at(5, "15:20"),
    "release_page",
    { kind: "release", id: "rel-stw-1" },
    "Release page: 0.4.0 Desktop preview",
  ),
  sys(
    at(4, "07:00"),
    "brief_ready",
    { kind: "brief", id: "brief-stw-2026-10-19" },
    "Weekly brief ready",
  ),
  say(
    "p-davide",
    at(2, "09:50"),
    "STW-R1 came from a customer call: they want to see who moved a task to another week.",
    { cites: [request("req-stw-1")] },
  ),
  sys(
    at(2, "10:00"),
    "task_closed",
    task("t-stw-1"),
    "Task closed: Fake data layer aware of the viewer",
  ),
  say(
    "p-marco",
    at(2, "10:15"),
    "The data layer knows who is looking now: every query key carries the person.",
    { react: [["🚀", ["p-laura", "p-simone", "p-federico"]]] },
  ),
  say(
    "p-elena",
    at(1, "15:00"),
    "@Sara Montanari can you check the wording of the stalled reasons with two customers before Monday?",
    { cites: [task("t-stw-4")], asks: ["p-sara"] },
  ),
  say(
    "p-simone",
    at(0, "10:50"),
    "Board keyboard moves (STW-3): the review asked for changes, the correction is running.",
    { cites: [task("t-stw-3"), repoFile("stubwise:apps/web/src/pages/board/useBoardKeys.ts")] },
  ),
  say("p-laura", at(0, "11:40"), "@channel demo of the desktop prototype today at 16:00.", {
    react: [["👍", ["p-marco", "p-giulia", "p-simone"]]],
  }),
];

const BOARD_KEYS = [
  "Keyboard drag on the board, as it works now:",
  "",
  "- **Space** picks the card up, **arrows** move it, **Space** drops it.",
  "- **Escape** puts it back where it was.",
  "",
  "```ts",
  'const MOVE_KEYS = { ArrowLeft: "prev-column", ArrowRight: "next-column", ArrowUp: "up", ArrowDown: "down" } as const;',
  "```",
].join("\n");

const desktop: Spec[] = [
  say("p-laura", at(13, "09:30"), "Icons for the rail are settled (STW-2). Next up: the board.", {
    cites: [task("t-stw-2")],
  }),
  say("p-simone", at(10, "11:00"), BOARD_KEYS, {
    cites: [task("t-stw-3")],
    replies: [
      say(
        "p-marco",
        at(10, "11:20"),
        "Screen readers need an announcement for each move, not only at the drop.",
      ),
      say("p-simone", at(10, "11:34"), "Yes, wired to the live region."),
    ],
  }),
  sys(at(4, "12:30"), "pr_opened", task("t-stw-1"), "PR #405 opened on stubwise/stubwise"),
  sys(at(2, "13:30"), "pr_merged", task("t-stw-1"), "PR #405 merged on stubwise/stubwise"),
  say(
    "p-giulia",
    at(1, "09:10"),
    "I'm writing the release notes for the desktop preview. How does weekly planning work, in two lines?",
    {
      cites: [task("t-stw-11")],
      replies: [
        say(
          "p-giulia",
          at(1, "09:12"),
          "@Claude explain weekly planning in two lines, from the docs.",
        ),
        {
          by: "claude",
          at: at(1, "09:13"),
          text: "Each task can be planned for a week. A task that ends its week still open slips to the next one, and its slip counter grows.",
          cites: [doc("doc-stw-planning")],
          claude: {
            calledBy: "p-giulia",
            events: [
              done(at(1, "09:13"), "search_docs", "Searched the STW docs", {
                input: "weekly planning",
                result: "Weekly planning",
              }),
              says(
                at(1, "09:13"),
                "Each task can be planned for a week. A task that ends its week still open slips to the next one, and its slip counter grows.",
              ),
              { at: at(1, "09:13"), type: "citation", refs: [doc("doc-stw-planning")] },
            ],
          },
        },
        say("p-giulia", at(1, "09:20"), "Perfect, thanks.", { react: [["👍", ["p-laura"]]] }),
      ],
    },
  ),
  sys(at(1, "14:30"), "pr_opened", task("t-stw-3"), "PR #411 opened on stubwise/stubwise"),
  say(
    "p-marco",
    at(0, "08:55"),
    "The resize crash (STW-13) has a fix waiting for approval. @Laura Costa can you look before lunch?",
    {
      cites: [task("t-stw-13")],
      asks: ["p-laura"],
      replies: [say("p-laura", at(0, "09:30"), "Looking now.")],
    },
  ),
];

export const STW_MESSAGES: ChatMessage[] = [
  ...channelFlow("ch-stw-general", general),
  ...channelFlow("ch-stw-desktop", desktop),
];
