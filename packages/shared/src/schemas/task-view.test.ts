import { describe, expect, it } from "vitest";
import { taskListQuerySchema, taskPatchSchema, taskViewSchema } from "./task-view.js";

const VIEW = {
  id: "0b1e6f3a-1111-4222-8333-444455556666",
  ticketId: "0b1e6f3a-1111-4222-8333-444455556666",
  number: 12,
  code: "AUD-12",
  projectId: "1c2d3e4f-1111-4222-8333-444455556666",
  title: "Il carrello si svuota",
  description: "",
  statusId: "2d3e4f5a-1111-4222-8333-444455556666",
  departmentId: "3e4f5a6b-1111-4222-8333-444455556666",
  assigneeId: null,
  createdById: null,
  followerIds: [],
  size: "M",
  dueDate: null,
  milestoneId: null,
  labels: [],
  type: "bug",
  priority: "medium",
  requestId: null,
  links: [],
  attachments: [],
  manualStall: null,
  claude: "none",
  createdAt: "2026-11-01T10:00:00.000Z",
  closedAt: null,
  lastActivityAt: "2026-11-02T10:00:00.000Z",
  source: "manual",
  occurrences: 1,
  technical: null,
};

describe("taskViewSchema", () => {
  it("una taskView senza claudeRun (un server più vecchio, una lettura) parsa con null", () => {
    expect(taskViewSchema.parse(VIEW).claudeRun).toBeNull();
    expect(taskViewSchema.parse({ ...VIEW, claudeRun: "refused:job_in_flight" }).claudeRun).toBe("refused:job_in_flight");
  });

  it("una taskView senza plannedWeek né slipCount parsa con i default", () => {
    const parsed = taskViewSchema.parse(VIEW);
    expect(parsed.plannedWeek).toBeNull();
    expect(parsed.slipCount).toBe(0);
  });

  it("una taskView senza i campi facoltativi della vista parsa", () => {
    const minimal: Record<string, unknown> = { ...VIEW };
    delete minimal.source;
    delete minimal.technical;
    expect(() => taskViewSchema.parse(minimal)).not.toThrow();
  });
});

describe("taskListQuerySchema", () => {
  it("gli array arrivano come stringhe separate da virgola", () => {
    expect(taskListQuerySchema.parse({ families: "todo,active", sizes: "XS,none", stalled: "true" })).toEqual({
      families: ["todo", "active"],
      sizes: ["XS", "none"],
      stalled: true,
    });
  });

  it("un valore fuori dominio è rifiutato", () => {
    expect(() => taskListQuerySchema.parse({ families: "todo,nope" })).toThrow();
  });
});

describe("taskPatchSchema", () => {
  it("tutto facoltativo, assegnatario e taglia annullabili", () => {
    expect(taskPatchSchema.parse({})).toEqual({});
    expect(taskPatchSchema.parse({ assigneeId: null, size: null })).toEqual({ assigneeId: null, size: null });
  });
});

describe("stallSchema", () => {
  it("un motivo che il client non conosce parsa da lettore come UNKNOWN", async () => {
    const { stallSchema } = await import("./task-view.js");
    const { readerSchema, UNKNOWN } = await import("../reader.js");
    expect(readerSchema(stallSchema).parse({ reason: { kind: "nuovo" }, since: "2026-11-01", days: 1 }).reason.kind).toBe(
      UNKNOWN,
    );
    expect(
      stallSchema.parse({ reason: { kind: "decision", personId: "p" }, since: "2026-11-01", days: 1 }).reason,
    ).toEqual({ kind: "decision", personId: "p" });
  });
});
