import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, DecisionRequest, ProjectRequest } from "../data/model";
import {
  markdownToText,
  requestFileName,
  requestToMarkdown,
  taskFileName,
  taskToMarkdown,
  type RequestExportContext,
  type TaskExportContext,
} from "./export";
import { makeTask } from "./fixtures";

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");

const NAMES: Record<string, string> = {
  u1: "Giulia Ferri",
  u2: "Elena Moretti",
  u3: "Paolo Greco",
};

const decision = (over: Partial<DecisionRequest>): DecisionRequest => ({
  id: "d1",
  taskId: "t1",
  askedById: "u1",
  askedOfId: "u2",
  question: "Go or wait?",
  options: ["Go", "Wait"],
  createdAt: "2026-10-20T09:00:00Z",
  withdrawnAt: null,
  answer: null,
  ...over,
});

const comment = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: "a1",
  taskId: "t1",
  kind: "comment",
  authorId: "u1",
  at: "2026-10-21T10:00:00Z",
  body: "Looks good to me.",
  ...over,
});

function taskCtx(over: Partial<TaskExportContext> = {}): TaskExportContext {
  return {
    language: "en",
    projectCode: "AUD",
    projectName: "Audin 2.0",
    statusName: "In progress",
    departmentName: "Development",
    milestoneName: "Public launch",
    personName: (id) => (id ? (NAMES[id] ?? null) : null),
    decisions: [],
    activity: [],
    ...over,
  };
}

describe("taskToMarkdown", () => {
  const task = makeTask({
    code: "AUD-5",
    title: "Export the call history",
    description: "Columns: date, contact.\n\n- no recordings",
    assigneeId: "u1",
    size: "M",
    dueDate: "2026-10-30",
    plannedWeek: "2026-W43",
    type: "bug",
    priority: "high",
    labels: ["export", "csv"],
  });

  it("titolo col codice, tutti i campi, la descrizione", () => {
    const md = taskToMarkdown(task, taskCtx(), en);
    expect(md.startsWith("# AUD-5 · Export the call history\n")).toBe(true);
    for (const line of [
      "- **Project:** AUD · Audin 2.0",
      "- **Status:** In progress",
      "- **Assignee:** Giulia Ferri",
      "- **Department:** Development",
      "- **Size:** M",
      "- **Due:** Oct 30, 2026",
      "- **Week:** W43 · Oct 19 – Oct 23",
      "- **Milestone:** Public launch",
      "- **Type:** Bug",
      "- **Priority:** High",
      "- **Labels:** export, csv",
    ]) {
      expect(md).toContain(line);
    }
    expect(md).toContain("## Description\n\nColumns: date, contact.\n\n- no recordings\n");
  });

  it("i campi vuoti si dicono, non spariscono", () => {
    const bare = makeTask({ code: "AUD-9", assigneeId: null, size: null, labels: [] });
    const md = taskToMarkdown(
      bare,
      taskCtx({ milestoneName: null, statusName: null, departmentName: null }),
      en,
    );
    expect(md).toContain("- **Assignee:** Unassigned");
    expect(md).toContain("- **Size:** No estimate");
    expect(md).toContain("- **Due:** No due date");
    expect(md).toContain("- **Milestone:** No milestone");
    expect(md).toContain("- **Labels:** No labels");
    expect(md).toContain("## Description\n\n_No description_");
    expect(md).not.toContain("## Decisions");
    expect(md).not.toContain("## Comments");
  });

  it("decisioni aperte e chiuse, separate", () => {
    const md = taskToMarkdown(
      task,
      taskCtx({
        decisions: [
          decision({ id: "d1" }),
          decision({
            id: "d2",
            question: "Which columns?",
            answer: { optionIndex: 0, text: null, at: "2026-10-21T09:00:00Z", byId: "u2" },
          }),
          decision({ id: "d3", question: "Ship Friday?", withdrawnAt: "2026-10-22T09:00:00Z" }),
        ],
      }),
      en,
    );
    const open = md.slice(md.indexOf("### Open"), md.indexOf("### Closed"));
    const closed = md.slice(md.indexOf("### Closed"));
    expect(open).toContain(
      "- **Go or wait?** — Elena Moretti decides · Asked by Giulia Ferri · Oct 20, 2026",
    );
    expect(open).toContain("  - Options: Go · Wait");
    expect(closed).toContain("- **Which columns?** — Elena Moretti chose «Go»");
    expect(closed).toContain("- **Ship Friday?** — Withdrawn by Giulia Ferri");
  });

  it("commenti in ordine, un eliminato resta come «Comment deleted», i cambi di campo no", () => {
    const md = taskToMarkdown(
      task,
      taskCtx({
        activity: [
          comment({
            id: "a2",
            at: "2026-10-22T10:00:00Z",
            body: "",
            deletedAt: "2026-10-22T11:00:00Z",
            deletedById: "u3",
          }),
          comment({ id: "a1" }),
          {
            id: "a3",
            taskId: "t1",
            kind: "field_change",
            authorId: "u1",
            at: "2026-10-21T11:00:00Z",
            field: "status",
            from: "To do",
            to: "In progress",
          },
        ],
      }),
      en,
    );
    const comments = md.slice(md.indexOf("## Comments"));
    expect(comments).toContain("**Giulia Ferri** · Oct 21, 2026\n\nLooks good to me.");
    expect(comments).toContain("_Comment deleted · by Paolo Greco_");
    expect(comments.indexOf("Looks good")).toBeLessThan(comments.indexOf("Comment deleted"));
    expect(comments).not.toContain("In progress");
  });

  it("l'origine e le occorrenze, se non è a mano", () => {
    const md = taskToMarkdown(makeTask({ source: "sdk", occurrences: 4 }), taskCtx(), en);
    expect(md).toContain("- **Source:** SDK · ×4");
    expect(taskToMarkdown(makeTask(), taskCtx(), en)).not.toContain("**Source:**");
  });

  it("nella lingua di chi esporta", () => {
    const md = taskToMarkdown(task, taskCtx({ language: "it" }), it_);
    expect(md).toContain("- **Assegnatario:** Giulia Ferri");
    expect(md).toContain("- **Priorità:** Alta");
    expect(md).toContain("## Descrizione");
  });

  it("il nome del file è il codice", () => {
    expect(taskFileName(task)).toBe("AUD-5.md");
  });
});

describe("requestToMarkdown", () => {
  const request: ProjectRequest = {
    id: "req-1",
    projectId: "p1",
    title: "Callback reminders by email",
    description: "Send a reminder the day before.",
    requesterIds: ["u1", "u2"],
    status: "ready",
    urgency: "high",
    size: "S",
    risk: "medium",
    riskNote: "Depends on the mail provider limits.",
    similarToId: null,
    mergedIntoId: null,
    taskIds: ["t1"],
    createdAt: "2026-10-17T11:00:00Z",
  };
  const ctx: RequestExportContext = {
    language: "en",
    projectCode: "AUD",
    projectName: "Audin 2.0",
    personName: (id) => (id ? (NAMES[id] ?? null) : null),
    tasks: [{ code: "AUD-13", title: "Reminder emails", statusName: "To do" }],
  };

  it("titolo, metadati, richiedenti, descrizione, task nate", () => {
    const md = requestToMarkdown(request, ctx, en);
    expect(md.startsWith("# Callback reminders by email\n")).toBe(true);
    for (const line of [
      "- **Project:** AUD · Audin 2.0",
      "- **Status:** Ready",
      "- **Urgency:** High",
      "- **Size:** S",
      "- **Risk:** Medium — Depends on the mail provider limits.",
      "- **Sent:** Oct 17, 2026",
      "- **Requested by:** Giulia Ferri, Elena Moretti",
    ]) {
      expect(md).toContain(line);
    }
    expect(md).toContain("## Description\n\nSend a reminder the day before.");
    expect(md).toContain("## Tasks from this request\n\n- AUD-13 · Reminder emails (To do)");
  });

  it("senza stima né rischio lo dice", () => {
    const md = requestToMarkdown(
      { ...request, size: null, risk: undefined, riskNote: null, taskIds: [] },
      { ...ctx, tasks: [] },
      en,
    );
    expect(md).toContain("- **Size:** No estimate");
    expect(md).toContain("- **Risk:** Not assessed");
    expect(md).not.toContain("## Tasks from this request");
  });

  it("il nome del file viene dal titolo", () => {
    expect(requestFileName(request)).toBe("request-callback-reminders-by-email.md");
    expect(requestFileName({ ...request, title: "Où? ¿Qué!" })).toBe("request-ou-que.md");
    expect(requestFileName({ ...request, title: "!!!" })).toBe("request.md");
  });
});

describe("markdownToText", () => {
  it("toglie i segni del markdown e lascia il testo", () => {
    expect(
      markdownToText(
        "## Where we are\n\nThe **launch** is *close*. See [the plan](http://x) and `AUD-5`.\n\n- one\n* two",
      ),
    ).toBe("Where we are\n\nThe launch is close. See the plan and AUD-5.\n\n- one\n- two");
  });
});
