import { slugify } from "../../domain/docs";
import type { DocKind, DocLink, DocPage, DocStaleCommit } from "../types";
import { COMMITS, fakeSha } from "./commits";
import { daysFromToday } from "./dates";
import { REPOSITORIES } from "./docs/repositories";

// Le pagine dei Docs, nello spazio del loro repository (STW, AUD e il
// progetto cliente CBV). Le prime nove sono quelle che Claude cita già nelle
// conversazioni del seme: gli id restano quelli. Il codice (`AUD-D3`) è il
// numero d'ordine nel progetto, stabile: le pagine nuove vanno in fondo.
// Titoli, percorsi ed estratti delle pagine aggiunte non parlano dei temi
// che le domande «come funziona…» dei test cercano (callback, import,
// contatti, pianificazione settimanale, rimborsi): quelle risposte restano.

interface Row {
  id: string;
  kind: DocKind;
  title: string;
  path: string;
  excerpt: string;
  body: string;
  /** La parte del codice documentata; assente per le manuali. */
  documents?: string;
  /** Giorni fa dell'ultimo aggiornamento. */
  updated: number;
  views: number;
  links?: DocLink[];
  /** I commit arrivati dopo l'ultimo aggiornamento, dai messaggi di `COMMITS`. */
  staleAfter?: string[];
}

const ROWS: Record<string, Row[]> = {
  AUD: [
    {
      id: "doc-aud-callbacks",
      kind: "functional",
      title: "Scheduled callbacks",
      path: "Guide / Dialer",
      excerpt:
        "A callback is stored in UTC and shown in the timezone of the workspace. Reminders go out 10 minutes before, by email and in the app.",
      body: "A callback is stored in UTC and shown in the timezone of the workspace.\n\n## Reminders\n\nReminders go out **10 minutes before**, by email and in the app. A callback moved to another day sends a new reminder; the old one is dropped.\n\n## Who sees it\n\nThe agent who scheduled it and the team lead of the workspace.",
      documents: "src/callbacks",
      updated: 9,
      views: 42,
      links: [{ type: "implemented_by", pageId: "doc-aud-reminder-job" }],
    },
    {
      id: "doc-aud-import",
      kind: "functional",
      title: "Importing contacts",
      path: "Guide / Contacts",
      excerpt:
        "The CSV import matches duplicates by email first, then by phone number. Rows that match an existing contact are shown in the preview before anything is saved.",
      body: "The CSV import matches duplicates by **email** first, then by **phone number**.\n\n## Preview\n\nRows that match an existing contact are shown in the preview before anything is saved. Each one can be merged, skipped or imported as new.\n\n## Encoding\n\nFiles in UTF-8 and Windows-1252 are both accepted.",
      documents: "src/import",
      updated: 12,
      views: 31,
    },
    {
      id: "doc-aud-billing",
      kind: "functional",
      title: "Invoices and billing emails",
      path: "Guide / Billing",
      excerpt:
        "Invoices are issued on the first working day of the month. The billing email uses the invoice layout of the workspace and attaches the PDF.",
      body: "Invoices are issued on the **first working day** of the month.\n\nThe billing email uses the invoice layout of the workspace and attaches the PDF. A failed delivery is retried twice, then shown to the workspace owner.",
      documents: "src/billing",
      updated: 20,
      views: 12,
    },
    {
      id: "doc-aud-export",
      kind: "functional",
      title: "Exporting the call history",
      path: "Guide / Reports",
      excerpt:
        "The export covers the selected period and the filters in use. Large exports are prepared in the background and arrive by email.",
      body: "The export covers the selected period and the filters in use.\n\n## Large exports\n\nLarge exports are prepared in the background and arrive by email.",
      documents: "src/calls",
      updated: 6,
      views: 8,
      links: [{ type: "implemented_by", pageId: "doc-aud-export-job" }],
      staleAfter: [
        "feat(export): background export for long periods",
        "feat(export): call history columns and spreadsheet download",
      ],
    },
    {
      id: "doc-aud-reminder-job",
      kind: "technical",
      title: "Reminder job",
      path: "Services / Dialer",
      excerpt:
        "A job that runs every minute and sends the notices that are due, by email and in the app.",
      body: "The job runs **every minute** and picks the notices due in the next minute.\n\n```ts\nconst due = await notices.dueBefore(addMinutes(now, 1));\n```\n\nA notice that fails is retried on the next run; after three failures it is logged and dropped.",
      documents: "src/callbacks/reminder.ts",
      updated: 9,
      views: 5,
      links: [{ type: "implements", pageId: "doc-aud-callbacks" }],
    },
    {
      id: "doc-aud-export-job",
      kind: "technical",
      title: "Export job",
      path: "Services / Reports",
      excerpt:
        "How the background export splits a long period into chunks and writes the spreadsheet.",
      body: "The export job splits a long period into **one-week chunks** and appends each chunk to the spreadsheet.\n\nThe file is stored for seven days; the email links to it.",
      documents: "src/calls/export-job.ts",
      updated: 6,
      views: 0,
      links: [
        { type: "implements", pageId: "doc-aud-export" },
        { type: "related", pageId: "doc-aud-billing" },
      ],
    },
    {
      id: "doc-aud-overview",
      kind: "product",
      title: "Audin 2.0 at a glance",
      path: "Overview",
      excerpt:
        "The dialer and CRM of the sales team: calls, leads, deals and invoices in one place.",
      body: "Audin is the dialer and CRM of the sales team.\n\n- **Calls**: the dialer, recordings and outcomes.\n- **Leads and deals**: the pipeline of each workspace.\n- **Invoices**: issued every month, sent by email.",
      documents: "src",
      updated: 20,
      views: 19,
    },
    {
      id: "doc-aud-release-checklist",
      kind: "manual",
      title: "Release checklist",
      path: "Team",
      excerpt:
        "What to check before a release goes out: migrations, the telephony SDK, the billing emails.",
      body: "1. Migrations run on a copy of production.\n2. The telephony SDK version matches the one in staging.\n3. One billing email is sent to the test workspace.",
      updated: 30,
      views: 3,
    },
  ],
  STW: [
    {
      id: "doc-stw-stalled",
      kind: "functional",
      title: "How stalled tasks work",
      path: "Guide / Tasks",
      excerpt:
        "A task is stalled when nobody touched it for longer than the project threshold, when it waits for a decision or for an answer to Claude, or when someone marked it by hand.",
      body: "A task is **stalled** when:\n\n- nobody touched it for longer than the project threshold;\n- it waits for a decision or for an answer to Claude;\n- someone marked it by hand.\n\nThe thresholds are set per project, in the settings.",
      documents: "apps/server/src/services/stalled.ts",
      updated: 4,
      views: 27,
      links: [{ type: "implemented_by", pageId: "doc-stw-stall-service" }],
    },
    {
      id: "doc-stw-planning",
      kind: "functional",
      title: "Weekly planning",
      path: "Guide / Planning",
      excerpt:
        "Each task can be planned for a week; a task that ends the week open slips to the next one and its counter grows.",
      body: "Each task can be planned for a week.\n\nA task that ends the week open **slips** to the next one and its counter grows.",
      documents: "apps/web/src/pages/planning",
      updated: 1,
      views: 22,
    },
    {
      id: "doc-stw-selfhost",
      kind: "manual",
      title: "Self-hosted upgrades",
      path: "Operations / Upgrades",
      excerpt:
        "Pull the new images, then restart the server before the worker: migrations run when the server starts.",
      body: "1. Pull the new images.\n2. Restart the **server** first: migrations run when it starts.\n3. Restart the **worker** when no generation is running.",
      updated: 15,
      views: 9,
    },
    {
      id: "doc-stw-notifications",
      kind: "functional",
      title: "Notifications and quiet hours",
      path: "Guide / Notifications",
      excerpt:
        "Notifications arrive in the inbox and, when enabled, as push messages. Quiet hours are not available yet.",
      body: "Notifications arrive in the inbox and, when enabled, as push messages.\n\nQuiet hours are not available yet.",
      documents: "packages/notifications",
      updated: 4,
      views: 14,
    },
    {
      id: "doc-stw-stall-service",
      kind: "technical",
      title: "Stall detection service",
      path: "Server / Services",
      excerpt:
        "Computes which tasks are stalled from the last touch, the open decisions and the project thresholds.",
      body: "The service reads the last touch of each task, its open decisions and the thresholds of its project.\n\n```ts\nexport function stallOf(task: Task, thresholds: Thresholds): Stall | null\n```",
      documents: "apps/server/src/services/stalled.ts",
      updated: 4,
      views: 6,
      links: [{ type: "implements", pageId: "doc-stw-stalled" }],
    },
    {
      id: "doc-stw-worker-pipeline",
      kind: "technical",
      title: "Worker pipeline",
      path: "Worker / Pipeline",
      excerpt:
        "The worker takes a job, prepares a worktree, runs the agent and opens the pull request.",
      body: "1. Take a job from the queue (`FOR UPDATE SKIP LOCKED`).\n2. Prepare a worktree on the repository mirror.\n3. Run the agent.\n4. Commit, push and open the pull request.",
      documents: "apps/worker/src/pipeline",
      updated: 4,
      views: 11,
      links: [{ type: "related", pageId: "doc-stw-selfhost" }],
    },
    {
      id: "doc-stw-overview",
      kind: "product",
      title: "What Stubwise is",
      path: "Overview",
      excerpt:
        "The place where the team keeps its projects: tasks, requests, docs and the work Claude does on the code.",
      body: "Stubwise keeps the projects of the team: tasks, requests, docs and the work Claude does on the code.",
      documents: "apps",
      updated: 4,
      views: 17,
    },
  ],
  CBV: [
    {
      id: "doc-cbv-shipping",
      kind: "manual",
      title: "Shipping rules",
      path: "Store / Shipping",
      excerpt:
        "Orders over 6 bottles ship free in Italy. Gift boxes are packed by hand and add one working day.",
      body: "Orders over **6 bottles** ship free in Italy.\n\nGift boxes are packed by hand and add one working day.",
      updated: 40,
      views: 4,
    },
  ],
};

/** Il commit da cui sono state generate le pagine di un repository. */
export const GENERATED_AT: Record<string, string> = {
  "repo-stw": fakeSha("docs|stubwise"),
  "repo-aud": fakeSha("docs|audin-app"),
};

function staleCommits(messages: string[] = []): DocStaleCommit[] {
  return messages.map((message) => {
    const commit = COMMITS.find((c) => c.message === message)!;
    return { sha: commit.sha, message: commit.message, at: commit.at };
  });
}

export const DOC_PAGES: DocPage[] = Object.entries(ROWS).flatMap(([code, rows]) => {
  const projectId = `prj-${code.toLowerCase()}`;
  const repositoryId = REPOSITORIES.find((r) => r.projectId === projectId)!.id;
  return rows.map(
    (row, i): DocPage => ({
      id: row.id,
      code: `${code}-D${i + 1}`,
      projectId,
      repositoryId,
      kind: row.kind,
      title: row.title,
      slug: slugify(row.title),
      path: row.path,
      excerpt: row.excerpt,
      body: row.body,
      documentsPath: row.documents ?? null,
      generatedAtCommit: row.kind === "manual" ? null : (GENERATED_AT[repositoryId] ?? null),
      updatedAt: `${daysFromToday(-row.updated)}T03:00:00Z`,
      staleCommits: staleCommits(row.staleAfter),
      links: row.links ?? [],
      views: row.views,
    }),
  );
});
