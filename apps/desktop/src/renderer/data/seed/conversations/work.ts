import { asks, at, done, says, seeded, type Seeded } from "./helpers";

// Sessioni di lavoro sulle task (una per ogni stato) e refine delle
// richieste. Il proprietario è chi ha chiesto il lavoro; lo stato di Claude
// sulla task (`task.claude` in `seed/tasks.ts`) è coerente con l'ultima
// sessione: al lavoro, aspetta una risposta, aspetta l'approvazione, fermata
// (pausa o fallita), fatta.

const STW13_PLAN = [
  "## Crash when the window is resized to the minimum",
  "",
  "### What happens",
  "",
  "`useFitSlots` computes how many rows fit in the column from the available height. At 1024 × 680 the header and the composer take more than the column, the available height becomes negative and `new Array(count)` throws `RangeError: Invalid array length`.",
  "",
  "### Changes",
  "",
  "1. `apps/desktop/src/renderer/layout/useFitSlots.ts` — clamp the count: `Math.max(0, Math.floor(available / rowHeight))`.",
  "2. Same file — when the count is 0, return an empty list instead of building the array, so the column shows its «Show all» link only.",
  "3. `apps/desktop/src/renderer/layout/useFitSlots.test.ts` — new test that renders the column at 1024 × 680 and at 800 × 600 and checks nothing throws and no row is cut in half.",
  "",
  "### Not changing",
  "",
  "- The row height and the minimum window size stay as they are.",
  "- No visible change at normal sizes.",
  "",
  "### Risks",
  "",
  "- Low. One function, covered by the new test and by the existing layout tests.",
].join("\n");

const STW13_SUMMARY =
  "Clamp the slot count so a window shorter than the header never asks for a negative array, and add a test at 1024 × 680. One file changes; nothing changes at normal sizes.";

const stw13 = seeded(
  {
    id: "cv-run-stw-13",
    kind: "task_run",
    title: "Crash when the window is resized to the minimum",
    ownerId: "p-marco",
    projectId: "prj-stw",
    taskId: "t-stw-13",
    state: "awaiting_approval",
  },
  [
    { at: at(0, "07:30"), type: "phase", phase: "plan", outcome: null },
    asks(
      at(0, "07:30"),
      "p-marco",
      "Start from the stack trace in the task: it happens every time at 1024 × 680.",
    ),
    done(at(0, "07:31"), "repo.read", "Reads apps/desktop/src/renderer/layout/useFitSlots.ts"),
    done(at(0, "07:31"), "repo.search", "Searches the code for “useFitSlots”", {
      result: "4 matches in 3 files",
    }),
    done(at(0, "07:33"), "shell", "Runs the layout tests at 1024 × 680", {
      input: "pnpm --filter @stubwise/desktop exec vitest run src/renderer/layout",
      result: "1 failed · RangeError: Invalid array length (useFitSlots.ts:42)",
    }),
    says(
      at(0, "07:34"),
      "I reproduced the crash: below a certain height the number of rows that fit becomes negative. The fix is small; here is the plan.",
    ),
    {
      at: at(0, "07:35"),
      type: "plan",
      planText: STW13_PLAN,
      summary: STW13_SUMMARY,
      status: "pending",
    },
    says(at(0, "07:35"), "The plan is ready and waits for someone who can approve plans in STW."),
  ],
);

const aud3 = seeded(
  {
    id: "cv-run-aud-3",
    kind: "task_run",
    title: "Import contacts from CSV with duplicates check",
    ownerId: "p-marco",
    projectId: "prj-aud",
    taskId: "t-aud-3",
    state: "awaiting_answer",
  },
  [
    { at: at(3, "10:05"), type: "phase", phase: "plan", outcome: null },
    done(at(3, "10:05"), "repo.read", "Reads src/import/match.ts"),
    done(at(3, "10:06"), "repo.read", "Reads src/import/preview.ts"),
    done(at(3, "10:06"), "docs.read", "Reads Importing contacts"),
    says(
      at(3, "10:08"),
      [
        "The import matches duplicates by email first, then by phone. Before I write the plan I need one rule that the task does not give:",
        "",
        "- a row with the **same phone** as an existing contact",
        "- but a **different email**",
        "",
        "is it the same person?",
      ].join("\n"),
    ),
    {
      at: at(3, "10:08"),
      type: "citation",
      refs: [
        { kind: "file", id: "audin-app:src/import/match.ts" },
        { kind: "doc", id: "doc-aud-import" },
      ],
    },
    {
      at: at(3, "10:09"),
      type: "question",
      questionId: "q-aud-3-1",
      text: "When an imported row matches an existing contact by phone but has a different email, what should the import do?",
      options: [
        {
          label: "Create a new contact",
          consequence:
            "Nothing is overwritten; possible duplicates are listed for someone to merge.",
          recommended: true,
        },
        {
          label: "Update the existing contact with the new email",
          consequence: "Fewer duplicates, but an email in use may be overwritten.",
        },
        {
          label: "Skip the row and list it in the import report",
          consequence: "The row is not imported until someone decides by hand.",
        },
      ],
      answer: null,
    },
  ],
);

const aud5 = seeded(
  {
    id: "cv-run-aud-5",
    kind: "task_run",
    title: "Export the call history as a spreadsheet",
    ownerId: "p-stefano",
    projectId: "prj-aud",
    taskId: "t-aud-5",
    state: "working",
  },
  [
    { at: at(1, "08:40"), type: "phase", phase: "plan", outcome: "ok" },
    {
      at: at(1, "08:52"),
      type: "plan",
      planText: [
        "## Export the call history as a spreadsheet",
        "",
        "1. Add an export endpoint that streams the calls of the selected period with the filters in use.",
        "2. Columns: date, duration, contact, company, outcome, operator, notes.",
        "3. Periods longer than a month are prepared in the background and sent by email.",
        "4. Download button on the call history page, disabled while an export is being prepared.",
        "5. Tests for the columns, the background path and the button state.",
      ].join("\n"),
      summary:
        "A spreadsheet export of the call history with the filters in use; long periods arrive by email.",
      status: "approved",
      decidedById: "p-laura",
    },
    { at: at(1, "09:30"), type: "phase", phase: "execution", outcome: null },
    done(at(1, "09:31"), "repo.edit", "Edits src/calls/export.ts"),
    done(at(1, "10:14"), "repo.edit", "Edits src/calls/export-job.ts"),
    done(at(0, "08:58"), "repo.edit", "Edits src/calls/CallHistoryPage.tsx"),
    done(at(0, "09:01"), "shell", "Runs the call history tests", {
      input: "pnpm vitest run src/calls",
      result: "24 passed",
    }),
    says(
      at(0, "09:03"),
      "Columns and download button are in place and the tests pass. Now the background path for long periods.",
    ),
    {
      at: at(0, "09:04"),
      type: "action",
      tool: "repo.edit",
      label: "Edits src/calls/export-mail.ts",
      state: "running",
    },
  ],
);

const stw3 = seeded(
  {
    id: "cv-run-stw-3",
    kind: "task_run",
    title: "Board view with keyboard drag and drop",
    ownerId: "p-simone",
    projectId: "prj-stw",
    taskId: "t-stw-3",
    state: "working",
  },
  [
    { at: at(2, "09:10"), type: "phase", phase: "execution", outcome: "ok" },
    done(at(2, "09:12"), "repo.edit", "Edits apps/desktop/src/renderer/pages/board/Board.tsx"),
    done(at(1, "11:20"), "shell", "Runs the board tests", { result: "31 passed" }),
    {
      at: at(1, "11:30"),
      type: "work_result",
      kind: "pr_opened",
      text: "Pull request #411 opened",
      link: "https://git.example.com/stubwise/stubwise/pull/411",
    },
    { at: at(1, "11:45"), type: "phase", phase: "review", outcome: "ok" },
    {
      at: at(1, "12:10"),
      type: "work_result",
      kind: "review",
      text: "Review: changes requested — the drop announcement is read twice by screen readers",
    },
    { at: at(0, "08:30"), type: "phase", phase: "correction", outcome: null },
    done(at(0, "08:31"), "repo.read", "Reads apps/desktop/src/renderer/pages/board/announce.ts"),
    done(at(0, "08:34"), "repo.edit", "Edits apps/desktop/src/renderer/pages/board/announce.ts"),
    says(
      at(0, "08:35"),
      "The announcement was emitted both by the live region and by the drop handler. I kept only the live region.",
    ),
    {
      at: at(0, "08:41"),
      type: "user",
      authorId: "p-laura",
      text: "Keep the announcement text in the locale files, not in the component.",
      attachments: [],
      delivery: "pending",
    },
    {
      at: at(0, "08:42"),
      type: "action",
      tool: "shell",
      label: "Runs the board tests",
      input: "pnpm --filter @stubwise/desktop exec vitest run src/renderer/pages/board",
      state: "running",
    },
  ],
);

// Al lavoro su MKX, dove Giulia è Project Lead: la sessione dal vivo che
// la persona di default vede appena apre l'app (lo script finisce con una
// domanda per lei).
const mkx11 = seeded(
  {
    id: "cv-run-mkx-11",
    kind: "task_run",
    title: "Banner sizes for the trade press",
    ownerId: "p-giulia",
    projectId: "prj-mkx",
    taskId: "t-mkx-11",
    state: "working",
  },
  [
    { at: at(0, "11:30"), type: "phase", phase: "execution", outcome: null },
    asks(
      at(0, "11:30"),
      "p-giulia",
      "Collect the banner sizes of the three trade magazines in the media plan and write them in the task.",
    ),
    done(at(0, "11:31"), "stubwise.read_task", "Reads MKX-3 · Media plan for April", {
      result: "3 trade magazines: Cucine Oggi, Arredo & Design, Il Mobile",
    }),
    done(at(0, "11:33"), "web.read", "Reads the advertising kit of Cucine Oggi", {
      result: "Print: full page 230 × 297 mm · web: 300 × 250, 728 × 90",
    }),
    {
      at: at(0, "11:35"),
      type: "action",
      tool: "web.read",
      label: "Reads the advertising kit of Arredo & Design",
      state: "running",
    },
  ],
);

const aud4 = seeded(
  {
    id: "cv-run-aud-4",
    kind: "task_run",
    title: "Billing emails with the new invoice layout",
    ownerId: "p-marco",
    projectId: "prj-aud",
    taskId: "t-aud-4",
    state: "paused",
  },
  [
    { at: at(2, "13:00"), type: "phase", phase: "plan", outcome: "ok" },
    {
      at: at(2, "13:00"),
      type: "plan",
      planText: [
        "## Billing emails with the new invoice layout",
        "",
        "1. Move the billing email templates to the invoice layout of the workspace.",
        "2. Attach the PDF generated by the invoice service instead of rebuilding it.",
        "3. Snapshot tests for the three email variants (first invoice, renewal, reminder).",
      ].join("\n"),
      summary: "The billing emails use the workspace invoice layout and attach the real PDF.",
      status: "pre_approved",
      decidedById: "p-laura",
    },
    { at: at(2, "13:02"), type: "phase", phase: "execution", outcome: null },
    done(at(2, "13:03"), "repo.read", "Reads src/billing/emails/renewal.tsx"),
    done(at(2, "13:10"), "repo.edit", "Edits src/billing/emails/layout.tsx"),
    asks(
      at(2, "13:14"),
      "p-laura",
      "Hold on: the invoice layout is changing again next week. Wait for the new design.",
    ),
    {
      at: at(2, "13:14"),
      type: "phase",
      phase: "execution",
      outcome: "stopped",
      stoppedById: "p-laura",
    },
    says(
      at(2, "13:15"),
      "Stopped. One file was edited and nothing was committed; I will start again from the new design when the work is resumed.",
    ),
    {
      at: at(2, "13:20"),
      type: "user",
      authorId: "p-marco",
      text: "Also keep the old footer for the reminder email.",
      attachments: [],
      delivery: "undelivered",
      undeliveredReason: "The session was paused before the message arrived.",
    },
  ],
);

const stw1Stopped = seeded(
  {
    id: "cv-run-stw-1-first",
    kind: "task_run",
    title: "Fake data layer aware of the viewer",
    ownerId: "p-marco",
    projectId: "prj-stw",
    taskId: "t-stw-1",
    state: "finished",
    outcome: "stopped",
  },
  [
    { at: at(10, "10:00"), type: "phase", phase: "execution", outcome: null },
    done(at(10, "10:02"), "repo.read", "Reads apps/desktop/src/renderer/data/api.ts"),
    done(at(10, "10:09"), "repo.edit", "Edits apps/desktop/src/renderer/data/api.ts"),
    asks(
      at(10, "10:12"),
      "p-marco",
      "Wrong approach: the filter must live in the store, not in every read. I will restart with a plan.",
    ),
    {
      at: at(10, "10:12"),
      type: "phase",
      phase: "execution",
      outcome: "stopped",
      stoppedById: "p-marco",
    },
  ],
);

const stw1 = seeded(
  {
    id: "cv-run-stw-1",
    kind: "task_run",
    title: "Fake data layer aware of the viewer",
    ownerId: "p-marco",
    projectId: "prj-stw",
    taskId: "t-stw-1",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(5, "09:00"), type: "phase", phase: "plan", outcome: "ok" },
    {
      at: at(5, "09:20"),
      type: "plan",
      planText: [
        "## Fake data layer aware of the viewer",
        "",
        "1. One `canSee` function in the store decides what each person sees.",
        "2. Every read goes through it; mutations check permissions with `need()` like the server.",
        "3. Query keys carry the person, so switching person never reuses stale results.",
        "4. Tests with the five personas on the same data.",
      ].join("\n"),
      summary: "Visibility decided in one place, every read and query key scoped to the person.",
      status: "approved",
      decidedById: "p-laura",
    },
    { at: at(5, "09:40"), type: "phase", phase: "execution", outcome: "ok" },
    done(at(5, "10:30"), "repo.edit", "Edits apps/desktop/src/renderer/data/store.ts"),
    done(at(5, "11:10"), "repo.edit", "Edits apps/desktop/src/renderer/data/queries.ts"),
    done(at(4, "09:05"), "shell", "Runs the desktop tests", { result: "412 passed" }),
    {
      at: at(4, "11:30"),
      type: "work_result",
      kind: "pr_opened",
      text: "Pull request #405 opened",
      link: "https://git.example.com/stubwise/stubwise/pull/405",
    },
    { at: at(4, "11:40"), type: "phase", phase: "review", outcome: "ok" },
    {
      at: at(4, "12:05"),
      type: "work_result",
      kind: "review",
      text: "Review: changes requested — 2 findings",
    },
    { at: at(3, "09:00"), type: "phase", phase: "correction", outcome: "ok" },
    done(at(3, "09:12"), "repo.edit", "Edits apps/desktop/src/renderer/data/queries.ts"),
    {
      at: at(3, "09:30"),
      type: "work_result",
      kind: "correction",
      text: "Correction 1 pushed to #405",
      link: "https://git.example.com/stubwise/stubwise/pull/405",
    },
    {
      at: at(3, "10:00"),
      type: "work_result",
      kind: "review",
      text: "Review: no further findings",
    },
    says(
      at(3, "10:01"),
      "The correction is on #405 and the second review found nothing more. It is ready to merge.",
    ),
  ],
);

const stw7 = seeded(
  {
    id: "cv-run-stw-7",
    kind: "task_run",
    title: "Saved filters shared with the team",
    ownerId: "p-federico",
    projectId: "prj-stw",
    taskId: "t-stw-7",
    state: "finished",
    outcome: "failed",
  },
  [
    { at: at(2, "15:00"), type: "phase", phase: "plan", outcome: "ok" },
    {
      at: at(2, "15:10"),
      type: "plan",
      planText: [
        "## Saved filters shared with the team",
        "",
        "1. A filter gets a visibility: private or public.",
        "2. Only the owner changes or deletes a public filter; others can copy it.",
        "3. The filter list shows public filters of the team under their own heading.",
      ].join("\n"),
      summary: "Filters can be made public; only the owner changes them.",
      status: "approved",
      decidedById: "p-laura",
    },
    { at: at(2, "15:12"), type: "phase", phase: "execution", outcome: null },
    done(at(2, "15:30"), "repo.edit", "Edits apps/desktop/src/renderer/data/api-mutations.ts"),
    {
      at: at(2, "15:41"),
      type: "action",
      tool: "shell",
      label: "Runs the desktop tests",
      input: "pnpm --filter @stubwise/desktop test",
      result: "3 failed · FiltersPage › shows the public filters of the team",
      state: "failed",
    },
    {
      at: at(2, "15:58"),
      type: "action",
      tool: "shell",
      label: "Runs the desktop tests",
      input: "pnpm --filter @stubwise/desktop test",
      result: "3 failed · FiltersPage › shows the public filters of the team",
      state: "failed",
    },
    { at: at(2, "16:00"), type: "phase", phase: "execution", outcome: "failed" },
    says(
      at(2, "16:00"),
      "The filters page tests still fail after two attempts: they expect the public filters in a different order than the one the plan describes. I stopped without opening a pull request.",
    ),
  ],
);

const refineQuietHours = seeded(
  {
    id: "cv-refine-stw-4",
    kind: "refine",
    title: "Quiet hours for notifications",
    ownerId: "p-laura",
    projectId: "prj-stw",
    requestId: "req-stw-4",
    state: "working",
  },
  [
    { at: at(0, "10:00"), type: "phase", phase: "refine", outcome: null },
    asks(
      at(0, "10:00"),
      "p-laura",
      "Elena asks for no push notifications at night. Let's write the design together.",
    ),
    done(at(0, "10:01"), "docs.read", "Reads Notifications and quiet hours"),
    done(at(0, "10:01"), "repo.search", "Searches the code for “sendPush”", {
      result: "6 matches in 4 files",
    }),
    says(
      at(0, "10:03"),
      [
        "A first shape:",
        "",
        "- quiet hours **per person**, from 20:00 to 08:00 by default, in the person's timezone;",
        "- during quiet hours notifications still reach the inbox, only the **push** waits;",
        "- at the end of the quiet hours one summary push, not one per notification.",
      ].join("\n"),
    ),
    {
      at: at(0, "10:04"),
      type: "work_result",
      kind: "design_updated",
      text: "Design updated: quiet hours per person, inbox untouched, one summary push",
    },
    asks(at(0, "10:07"), "p-elena", "Mentions should still come through, even at night."),
    says(
      at(0, "10:08"),
      "Agreed: a direct mention skips the quiet hours. I am adding it to the design and starting the plan.",
    ),
    {
      at: at(0, "10:08"),
      type: "work_result",
      kind: "design_updated",
      text: "Design updated: direct mentions skip the quiet hours",
    },
    {
      at: at(0, "10:09"),
      type: "action",
      tool: "backlog.set_plan",
      label: "Writes the plan",
      state: "running",
    },
  ],
);

const refineReminders = seeded(
  {
    id: "cv-refine-aud-2",
    kind: "refine",
    title: "Callback reminders by email",
    ownerId: "p-laura",
    projectId: "prj-aud",
    requestId: "req-aud-2",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: at(5, "14:00"), type: "phase", phase: "refine", outcome: null },
    asks(
      at(5, "14:00"),
      "p-laura",
      "Alessia wants the callback reminder by email too. What does it take?",
    ),
    done(at(5, "14:01"), "docs.read", "Reads Scheduled callbacks"),
    says(
      at(5, "14:03"),
      "Reminders already go out by email for the workspace owner; extending them to the operator needs a setting per person and respects the sending limits of the mail provider.",
    ),
    {
      at: at(5, "14:04"),
      type: "work_result",
      kind: "design_updated",
      text: "Design updated: email reminder per operator, opt-in",
    },
    {
      at: at(5, "14:12"),
      type: "work_result",
      kind: "plan_updated",
      text: "Plan updated: 4 steps, size S",
    },
    { at: at(5, "14:15"), type: "phase", phase: "refine", outcome: "ok" },
  ],
);

export const WORK_CONVERSATIONS: Seeded[] = [
  stw13,
  aud3,
  aud5,
  stw3,
  mkx11,
  aud4,
  stw1Stopped,
  stw1,
  stw7,
  refineQuietHours,
  refineReminders,
];
