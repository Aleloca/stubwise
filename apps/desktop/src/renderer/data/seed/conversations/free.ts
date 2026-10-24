import { asks, at, done, says, seeded, type Seeded } from "./helpers";

// Conversazioni libere: di Giulia (una pubblica che tocca AUD, che Sara non
// vede), di Marco (una con allegati e codice, una che continua la pubblica di
// Giulia) e di Laura (pubblica su STW). Le proposte le conferma solo chi le
// ha chieste, cioè l'autore della conversazione.

const giuliaStatus = seeded(
  {
    id: "cv-giulia-week",
    kind: "free",
    title: "Where do my projects stand this week?",
    ownerId: "p-giulia",
    state: "idle",
    touchedProjectIds: ["prj-mkx", "prj-olv", "prj-stw"],
  },
  [
    asks(at(0, "08:52"), "p-giulia", "Where do my projects stand this week?"),
    done(at(0, "08:52"), "stubwise.list_projects", "Reads the pulse of your pinned projects", {
      result: "14 projects · 3 wait on you · 2 with stalled tasks",
    }),
    done(at(0, "08:52"), "stubwise.list_tasks", "Reads the open tasks of MKX", {
      input: "project: MKX · status: open",
      result: "9 open tasks",
    }),
    done(at(0, "08:53"), "stubwise.list_decisions", "Reads the decisions waiting for you", {
      result: "3 open decisions",
    }),
    says(
      at(0, "08:53"),
      [
        "Here is the week in your pinned projects.",
        "",
        "**Needs you**",
        "- **MKX** — two decisions wait for you: how to split the April budget (MKX-3) and when to send the showroom invitations (MKX-9).",
        "- **OLV** — the request for new homepage photos (OLV-R1) has no estimate yet.",
        "",
        "**Moving**",
        "- **STW** — the board view with keyboard moves is in progress; Claude is applying a correction to its pull request (STW-3).",
        "- **MKX** — the landing page copy and the hero photo moved forward yesterday.",
        "",
        "**Stalled**",
        "- MKX-5, the dealers' price list, has been waiting on the client for six days.",
        "",
        "The German translation (MKX-7) is planned for next week but it is blocked by the landing page copy. Do you want me to move it one week later?",
      ].join("\n"),
    ),
    {
      at: at(0, "08:53"),
      type: "citation",
      refs: [
        { kind: "task", id: "t-mkx-3" },
        { kind: "task", id: "t-mkx-9" },
        { kind: "request", id: "req-olv-1" },
        { kind: "task", id: "t-stw-3" },
        { kind: "task", id: "t-mkx-5" },
        { kind: "task", id: "t-mkx-7" },
      ],
    },
    asks(at(0, "08:55"), "p-giulia", "Yes, move it one week later."),
    says(at(0, "08:55"), "Here is the change. Nothing happens until you confirm it."),
    {
      at: at(0, "08:55"),
      type: "proposal",
      proposalId: "prop-giulia-week-1",
      requesterId: "p-giulia",
      actions: [
        {
          fn: "planTask",
          args: { id: "t-mkx-7", plan: { assigneeId: "p-chiara", week: "2026-W45" } },
          summary: "Plan MKX-7 · Translate the landing page into German for week 45",
        },
      ],
      status: "open",
    },
  ],
);

const giuliaPhotos = seeded(
  {
    id: "cv-giulia-photos",
    kind: "free",
    title: "New photos for the Oleificio homepage",
    ownerId: "p-giulia",
    contextProjectId: "prj-olv",
    state: "idle",
    touchedProjectIds: ["prj-olv"],
  },
  [
    {
      at: at(3, "10:41"),
      type: "user",
      authorId: "p-giulia",
      text: "The client sent these shots of the olive grove. Can you open a request in OLV to put them on the homepage?",
      attachments: [
        { id: "att-cv-photos-1", name: "uliveto-alba.jpg", sizeBytes: 2_481_337, kind: "image" },
        {
          id: "att-cv-photos-2",
          name: "frantoio-interno.jpg",
          sizeBytes: 1_903_220,
          kind: "image",
        },
      ],
      delivery: "delivered",
    },
    done(at(3, "10:41"), "stubwise.list_backlog", "Looks for similar requests in OLV", {
      result: "No similar request",
    }),
    says(
      at(3, "10:42"),
      "Nothing similar is open in OLV. Here is the request, with the two photos attached and your words as the description.",
    ),
    {
      at: at(3, "10:42"),
      type: "proposal",
      proposalId: "prop-giulia-photos-1",
      requesterId: "p-giulia",
      actions: [
        {
          fn: "createRequest",
          args: {
            projectId: "prj-olv",
            title: "New photos of the olive grove on the homepage",
            urgency: "medium",
          },
          summary: "Open a request in OLV · New photos of the olive grove on the homepage",
        },
      ],
      status: "confirmed",
      resultCodes: ["OLV-R1"],
    },
    says(at(3, "10:43"), "Done: OLV-R1 is open. The team will estimate it."),
    { at: at(3, "10:43"), type: "citation", refs: [{ kind: "request", id: "req-olv-1" }] },
  ],
);

const giuliaCallbacks = seeded(
  {
    id: "cv-giulia-callbacks",
    kind: "free",
    title: "Why did a callback reminder arrive an hour late?",
    ownerId: "p-giulia",
    contextProjectId: "prj-aud",
    state: "idle",
    visibility: "public",
    publishedAt: at(1, "16:05"),
    publishedById: "p-giulia",
    touchedProjectIds: ["prj-aud", "prj-stw"],
    updatedAt: at(1, "16:05"),
  },
  [
    asks(
      at(2, "14:10"),
      "p-giulia",
      "A customer asked why a callback reminder in Audin arrived an hour late. How do scheduled callbacks work?",
    ),
    done(at(2, "14:10"), "docs.search", "Searches the AUD Docs for “callbacks”", {
      input: "callbacks reminder timezone",
      result: "2 pages",
    }),
    done(at(2, "14:10"), "docs.read", "Reads Scheduled callbacks"),
    done(
      at(2, "14:11"),
      "stubwise.get_ticket",
      "Reads AUD-9 · Fix the timezone of scheduled callbacks",
    ),
    done(at(2, "14:11"), "docs.read", "Reads Notifications and quiet hours in STW"),
    says(
      at(2, "14:11"),
      [
        "### How a scheduled callback works",
        "",
        "1. The callback is **stored in UTC** and shown in the timezone of the workspace.",
        "2. The reminder goes out **10 minutes before**, by email and in the app.",
        "3. In the app, the reminder arrives through the same notifications as everything else.",
        "",
        "### Why it arrived late",
        "",
        "Until 20 October, callbacks created right before the switch to winter time were converted with the old offset, so their reminder fired one hour late. The fix shipped with **AUD-9** and is closed.",
        "",
        "Callbacks created *before* the fix keep the wrong time: they need to be moved by hand once.",
      ].join("\n"),
    ),
    {
      at: at(2, "14:11"),
      type: "citation",
      refs: [
        { kind: "doc", id: "doc-aud-callbacks" },
        { kind: "task", id: "t-aud-9" },
        { kind: "doc", id: "doc-stw-notifications" },
      ],
    },
    asks(at(2, "14:14"), "p-giulia", "Can you write it as a short answer for the customer?"),
    says(
      at(2, "14:14"),
      [
        "Here is a reply you can paste:",
        "",
        "> Hello, thank you for letting us know. A bug made some reminders arrive one hour late after the change to winter time; it was fixed on 20 October. Callbacks you scheduled before that date may still show the old time: moving them once fixes them for good. We are sorry for the trouble.",
      ].join("\n"),
    ),
  ],
);

const giuliaIdeas = seeded(
  {
    id: "cv-giulia-subjects",
    kind: "free",
    title: "Subject lines for the Mix Cucine newsletter",
    ownerId: "p-giulia",
    state: "idle",
    archived: true,
    touchedProjectIds: ["prj-mkx"],
  },
  [
    asks(
      at(9, "15:30"),
      "p-giulia",
      "Give me five subject lines for a kitchen showroom newsletter. Warm, not pushy.",
    ),
    says(
      at(9, "15:30"),
      [
        "- Come and cook with us this spring",
        "- Our new kitchens, in person",
        "- Coffee is on us at the showroom",
        "- See it, touch it, imagine it at home",
        "- An afternoon among wood, stone and light",
      ].join("\n"),
    ),
    asks(at(9, "15:33"), "p-giulia", "Nice. Add a task in MKX to test the last two."),
    {
      at: at(9, "15:33"),
      type: "proposal",
      proposalId: "prop-giulia-subjects-1",
      requesterId: "p-giulia",
      actions: [
        {
          fn: "createTask",
          args: { projectId: "prj-mkx", title: "A/B test of two newsletter subject lines" },
          summary: "Create a task in MKX · A/B test of two newsletter subject lines",
        },
      ],
      status: "expired",
    },
  ],
);

const marcoImport = seeded(
  {
    id: "cv-marco-import",
    kind: "free",
    title: "Why does the CSV import drop rows?",
    ownerId: "p-marco",
    contextProjectId: "prj-aud",
    state: "idle",
    touchedProjectIds: ["prj-aud"],
  },
  [
    {
      at: at(1, "11:20"),
      type: "user",
      authorId: "p-marco",
      text: "Why does the CSV import drop rows when two contacts share a phone number? Sample file and the preview attached.",
      attachments: [
        { id: "att-cv-import-1", name: "import-sample.csv", sizeBytes: 18_432, kind: "file" },
        { id: "att-cv-import-2", name: "preview.png", sizeBytes: 241_090, kind: "image" },
      ],
      delivery: "delivered",
    },
    done(at(1, "11:20"), "repo.search", "Searches the code for “matchDuplicate”", {
      input: "matchDuplicate",
      result: "3 matches in 2 files",
    }),
    done(at(1, "11:20"), "repo.read", "Reads src/import/match.ts"),
    done(at(1, "11:21"), "repo.read", "Reads src/import/preview.ts"),
    done(at(1, "11:21"), "docs.read", "Reads Importing contacts"),
    done(
      at(1, "11:21"),
      "stubwise.get_ticket",
      "Reads AUD-3 · Import contacts from CSV with duplicates check",
    ),
    says(
      at(1, "11:22"),
      [
        "The rows are not dropped: they are **merged** into the first contact with the same phone number. This is the match today:",
        "",
        "```ts",
        "// src/import/match.ts",
        "export function matchDuplicate(row: ImportRow, existing: Contact[]): Contact | undefined {",
        "  return (",
        "    existing.find((c) => c.email !== null && c.email === row.email) ??",
        "    existing.find((c) => normalizePhone(c.phone) === normalizePhone(row.phone))",
        "  );",
        "}",
        "```",
        "",
        "With your sample file:",
        "",
        "- rows 14 and 15 share `+39 02 4455 1200` (the switchboard of the same company);",
        "- row 15 has a different email, but the phone match wins, so it is folded into row 14;",
        "- the preview shows only one contact, which looks like a lost row.",
        "",
        "Whether a phone match with a different email is the same person is exactly the open question on AUD-3: Claude asked it two days ago and nobody answered yet.",
      ].join("\n"),
    ),
    {
      at: at(1, "11:22"),
      type: "citation",
      refs: [
        { kind: "file", id: "audin-app:src/import/match.ts" },
        { kind: "doc", id: "doc-aud-import" },
        { kind: "task", id: "t-aud-3" },
      ],
    },
    asks(
      at(1, "11:25"),
      "p-marco",
      "Ok, add a comment on AUD-3 with the example so whoever answers sees it.",
    ),
    says(at(1, "11:25"), "Here is the comment. It is posted in your name when you confirm."),
    {
      at: at(1, "11:25"),
      type: "proposal",
      proposalId: "prop-marco-import-1",
      requesterId: "p-marco",
      actions: [
        {
          fn: "addComment",
          args: {
            taskId: "t-aud-3",
            body: "Example from a real file: two contacts of the same company share the switchboard number, so the second one is merged into the first.",
          },
          summary: "Comment on AUD-3 · Example of two contacts sharing a switchboard number",
        },
      ],
      status: "cancelled",
    },
    asks(at(1, "11:27"), "p-marco", "Never mind, I will answer the question on the task myself."),
    says(at(1, "11:27"), "All right, I did not post anything."),
  ],
);

const marcoContinues = seeded(
  {
    id: "cv-marco-callbacks",
    kind: "free",
    title: "Reminder timezone: user or workspace?",
    ownerId: "p-marco",
    contextProjectId: "prj-aud",
    state: "idle",
    continuesFromId: "cv-giulia-callbacks",
    touchedProjectIds: ["prj-aud"],
  },
  [
    asks(
      at(0, "09:40"),
      "p-marco",
      "Following up on this: does the reminder use the timezone of the user or of the workspace?",
    ),
    done(at(0, "09:40"), "repo.read", "Reads src/callbacks/reminder.ts"),
    says(
      at(0, "09:41"),
      [
        "Of the **workspace**. The reminder is scheduled from the stored UTC time and formatted with the workspace setting:",
        "",
        "```ts",
        'const local = formatInTimeZone(callback.dueAt, workspace.timezone, "HH:mm");',
        "```",
        "",
        "A person working from another timezone sees the time of the office, not their own. The Docs say the same.",
      ].join("\n"),
    ),
    {
      at: at(0, "09:41"),
      type: "citation",
      refs: [
        { kind: "file", id: "audin-app:src/callbacks/reminder.ts" },
        { kind: "doc", id: "doc-aud-callbacks" },
      ],
    },
  ],
);

const lauraSlipped = seeded(
  {
    id: "cv-laura-slipped",
    kind: "free",
    title: "What slipped in Stubwise this month?",
    ownerId: "p-laura",
    contextProjectId: "prj-stw",
    state: "idle",
    visibility: "public",
    publishedAt: at(1, "09:30"),
    publishedById: "p-laura",
    touchedProjectIds: ["prj-stw"],
    updatedAt: at(1, "09:30"),
  },
  [
    asks(at(1, "09:12"), "p-laura", "What slipped in Stubwise this month, and why?"),
    done(at(1, "09:12"), "stubwise.list_tasks", "Reads the tasks of STW that slipped", {
      input: "project: STW · slipped: yes",
      result: "2 tasks",
    }),
    says(
      at(1, "09:13"),
      [
        "Two tasks slipped this month:",
        "",
        "| Task | Slips | Why |",
        "| --- | --- | --- |",
        "| STW-8 · Upgrade guide for self-hosted instances | 2 | No activity for 16 days; it waits for the release notes. |",
        "| STW-11 · Release notes for the desktop preview | 1 | Nobody is assigned. |",
        "",
        "Both depend on the desktop preview being frozen, which is planned for next week.",
      ].join("\n"),
    ),
    {
      at: at(1, "09:13"),
      type: "citation",
      refs: [
        { kind: "task", id: "t-stw-8" },
        { kind: "task", id: "t-stw-11" },
        { kind: "doc", id: "doc-stw-planning" },
      ],
    },
  ],
);

export const FREE_CONVERSATIONS: Seeded[] = [
  giuliaStatus,
  giuliaPhotos,
  giuliaCallbacks,
  giuliaIdeas,
  marcoImport,
  marcoContinues,
  lauraSlipped,
];
