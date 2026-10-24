import { at, done, says, seeded, type Seeded } from "./helpers";

// Sessioni automatiche, in sola lettura: review di una PR, Docs del giro
// notturno, brief settimanale, report giornaliero, classificazione della
// posta (solo del titolare della casella), stima e merge dell'intake. Il
// proprietario è chi ha acceso o chiesto il lavoro.

const reviewStw405 = seeded(
  {
    id: "cv-review-stw-405",
    kind: "pr_review",
    title: "Review of #405 · Fake data layer aware of the viewer",
    ownerId: "p-marco",
    projectId: "prj-stw",
    taskId: "t-stw-1",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(4, "11:40"), type: "phase", phase: "review", outcome: null },
    done(at(4, "11:41"), "repo.diff", "Reads the diff of #405", { result: "9 files · +612 −148" }),
    done(at(4, "11:50"), "repo.read", "Reads apps/desktop/src/renderer/data/queries.ts"),
    says(
      at(4, "12:04"),
      [
        "**Changes requested — 2 findings**",
        "",
        "1. `useTasks` builds its key without the person when the filter is empty, so switching person can show the previous list for a moment.",
        "2. `resetApi` does not clear the grants given by `createProject`.",
        "",
        "Everything else follows the plan.",
      ].join("\n"),
    ),
    {
      at: at(4, "12:05"),
      type: "work_result",
      kind: "review",
      text: "Review: changes requested — 2 findings",
    },
    { at: at(4, "12:05"), type: "phase", phase: "review", outcome: "ok" },
  ],
);

const docsStw = seeded(
  {
    id: "cv-docs-stw-nightly",
    kind: "docs",
    title: "Nightly Docs update · Stubwise",
    ownerId: "p-laura",
    projectId: "prj-stw",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(0, "00:02"), type: "phase", phase: "commit summaries", outcome: "ok" },
    done(at(0, "00:03"), "repo.log", "Reads the new commits", { result: "4 commits" }),
    { at: at(0, "00:06"), type: "phase", phase: "pages", outcome: null },
    done(at(0, "00:09"), "docs.read", "Reads Weekly planning"),
    done(at(0, "00:14"), "docs.write", "Updates Weekly planning"),
    done(at(0, "00:21"), "docs.write", "Updates How stalled tasks work"),
    says(
      at(0, "00:22"),
      "Two pages updated: how a slipped task moves to the next week, and the threshold of stalled tasks per project.",
    ),
    {
      at: at(0, "00:22"),
      type: "citation",
      refs: [
        { kind: "doc", id: "doc-stw-planning" },
        { kind: "doc", id: "doc-stw-stalled" },
      ],
    },
    { at: at(0, "00:22"), type: "phase", phase: "pages", outcome: "ok" },
  ],
);

const docsAud = seeded(
  {
    id: "cv-docs-aud-nightly",
    kind: "docs",
    title: "Nightly Docs update · Audin 2.0",
    ownerId: "p-laura",
    projectId: "prj-aud",
    state: "finished",
    outcome: "timed_out",
  },
  [
    { at: at(1, "00:05"), type: "phase", phase: "pages", outcome: null },
    done(at(1, "00:07"), "docs.read", "Reads Exporting the call history"),
    {
      at: at(1, "00:45"),
      type: "action",
      tool: "repo.read",
      label: "Reads src/calls/export.ts",
      state: "failed",
      result: "Timed out after 40 minutes",
    },
    { at: at(1, "00:45"), type: "phase", phase: "pages", outcome: "timed_out" },
  ],
);

const briefMkx = seeded(
  {
    id: "cv-brief-mkx",
    kind: "brief",
    title: "Weekly brief · Campagne primavera Mix Cucine",
    ownerId: "p-giulia",
    projectId: "prj-mkx",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(4, "05:00"), type: "phase", phase: "brief", outcome: null },
    done(at(4, "05:01"), "stubwise.timeline", "Reads last week's timeline of MKX"),
    done(at(4, "05:01"), "stubwise.list_decisions", "Reads the decisions of MKX"),
    says(
      at(4, "05:03"),
      "The brief for the week of 12–18 October is ready: the spring campaign is on track, the dealers' price list waits on the client.",
    ),
    { at: at(4, "05:03"), type: "citation", refs: [{ kind: "project", id: "prj-mkx" }] },
    { at: at(4, "05:03"), type: "phase", phase: "brief", outcome: "ok" },
  ],
);

const dailyAud = seeded(
  {
    id: "cv-daily-aud",
    kind: "daily_report",
    title: "Daily report · Audin 2.0 · 22 October",
    ownerId: "p-laura",
    projectId: "prj-aud",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(0, "00:20"), type: "phase", phase: "daily report", outcome: null },
    done(at(0, "00:20"), "repo.log", "Reads the commits of 22 October", { result: "5 commits" }),
    says(
      at(0, "00:21"),
      "Work on the call history export: the spreadsheet columns and the download button.",
    ),
    { at: at(0, "00:21"), type: "phase", phase: "daily report", outcome: "ok" },
  ],
);

const mailGiulia = seeded(
  {
    id: "cv-mail-giulia",
    kind: "mail_classify",
    title: "Email classification · 3 messages",
    ownerId: "p-giulia",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(0, "07:10"), type: "phase", phase: "classification", outcome: null },
    done(at(0, "07:10"), "mail.read", "Reads «Spring discounts — confirmation» from Mix Cucine"),
    done(at(0, "07:10"), "mail.read", "Reads «Your receipt» from the print shop"),
    done(at(0, "07:11"), "mail.read", "Reads «October newsletter» from a supplier"),
    says(
      at(0, "07:11"),
      [
        "- **Mix Cucine** confirms the spring discounts: proposal for MKX, a comment on MKX-5.",
        "- The receipt and the newsletter are kept out.",
      ].join("\n"),
    ),
    {
      at: at(0, "07:11"),
      type: "citation",
      refs: [
        { kind: "project", id: "prj-mkx" },
        { kind: "task", id: "t-mkx-5" },
      ],
    },
    { at: at(0, "07:11"), type: "phase", phase: "classification", outcome: "ok" },
  ],
);

const intakeAud2 = seeded(
  {
    id: "cv-intake-aud-2",
    kind: "intake",
    title: "Estimate · Callback reminders by email",
    ownerId: "p-alessia",
    projectId: "prj-aud",
    requestId: "req-aud-2",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(6, "11:01"), type: "phase", phase: "estimate", outcome: null },
    done(at(6, "11:01"), "docs.search", "Searches the AUD Docs for “reminder”", {
      result: "1 page",
    }),
    says(
      at(6, "11:02"),
      "Size **S**, risk **medium**: it depends on the sending limits of the mail provider.",
    ),
    { at: at(6, "11:02"), type: "phase", phase: "estimate", outcome: "ok" },
  ],
);

const intakeMkx4 = seeded(
  {
    id: "cv-intake-mkx-4",
    kind: "intake",
    title: "Merge · Event page for the showroom",
    ownerId: "p-matteo",
    projectId: "prj-mkx",
    requestId: "req-mkx-4",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(1, "11:01"), type: "phase", phase: "merge", outcome: null },
    done(at(1, "11:01"), "stubwise.list_backlog", "Looks for similar requests in MKX", {
      result: "1 similar: MKX-R2",
    }),
    says(
      at(1, "11:02"),
      "Same showroom event as MKX-R2: merged into it, with Matteo as a second requester.",
    ),
    {
      at: at(1, "11:02"),
      type: "citation",
      refs: [
        { kind: "request", id: "req-mkx-2" },
        { kind: "request", id: "req-mkx-4" },
      ],
    },
    { at: at(1, "11:02"), type: "phase", phase: "merge", outcome: "ok" },
  ],
);

export const AUTOMATIC_CONVERSATIONS: Seeded[] = [
  reviewStw405,
  docsStw,
  docsAud,
  briefMkx,
  dailyAud,
  mailGiulia,
  intakeAud2,
  intakeMkx4,
];
