import { describe, expect, it } from "vitest";
import type { ProjectRequest, Task } from "../../data/model";
import { customerStatus } from "./customerStatus";
import { releaseStatus } from "./releaseStatus";

const request = (over: Partial<ProjectRequest> = {}): ProjectRequest => ({
  id: "req-x",
  code: "AUD-R1",
  projectId: "prj-aud",
  title: "x",
  description: "",
  requesterIds: [],
  status: "new",
  urgency: "medium",
  similarToId: null,
  mergedIntoId: null,
  taskIds: [],
  createdAt: "2026-10-28T10:00:00Z",
  ...over,
});

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t-x",
    code: "AUD-9",
    projectId: "prj-aud",
    claude: "none",
    closedAt: null,
    ...over,
  }) as Task;

const converted = request({ status: "converted", taskIds: ["t-x"] });

describe("customerStatus", () => {
  it("nessuna richiesta ancora (triage in corso) → received", () => {
    expect(customerStatus(null, [], [])).toBe("received");
  });
  it("richiesta nuova → received; in refine → evaluating; pronta → planned", () => {
    expect(customerStatus(request(), [], [])).toBe("received");
    expect(customerStatus(request({ status: "refining" }), [], [])).toBe("evaluating");
    expect(customerStatus(request({ status: "ready" }), [], [])).toBe("planned");
  });
  it("archiviata → not_proceeding; fusa in un'altra non lo è", () => {
    expect(customerStatus(request({ status: "archived" }), [], [])).toBe("not_proceeding");
    expect(customerStatus(request({ status: "archived", mergedIntoId: "req-y" }), [], [])).toBe(
      "evaluating",
    );
  });
  it("trasformata, task non ancora avviata → planned", () => {
    expect(customerStatus(converted, [task()], [])).toBe("planned");
    expect(customerStatus(converted, [], [])).toBe("planned");
  });
  it("trasformata, Claude al lavoro o in attesa → in_progress", () => {
    for (const claude of [
      "working",
      "awaiting_answer",
      "awaiting_approval",
      "stopped",
      "done",
    ] as const) {
      expect(customerStatus(converted, [task({ claude })], [])).toBe("in_progress");
    }
  });
  it("mergiata ma non ancora rilasciata → in_progress", () => {
    for (const kind of ["running", "failed", "not_in_production", "unavailable"] as const) {
      expect(customerStatus(converted, [task({ claude: "done" })], [kind])).toBe("in_progress");
    }
  });
  it("rilascio riuscito o in produzione → released", () => {
    expect(customerStatus(converted, [task({ claude: "done" })], ["succeeded"])).toBe("released");
    expect(customerStatus(converted, [task()], ["failed", "in_production"])).toBe("released");
  });
  it("task tutte chiuse senza rilascio → not_proceeding", () => {
    expect(customerStatus(converted, [task({ closedAt: "2026-10-28T12:00:00Z" })], [])).toBe(
      "not_proceeding",
    );
  });
  it("rilasciata resta rilasciata dopo un deploy più nuovo in produzione", () => {
    const kind = releaseStatus(
      {
        id: "rel-x",
        code: "AUD-V1",
        projectId: "prj-aud",
        repositoryId: "repo-aud",
        pr: { repo: "audin/audin-app", number: 1 },
        title: "x",
        mergeSha: "4be1f0c27a9d3e5b6c8f0a1d2e3b4c5d6e7f8091",
        mergedAt: "2026-10-28T10:00:00Z",
        mergedById: null,
        mergedGitName: "x",
        viaStubwise: true,
        runs: [],
        seenInProductionAt: "2026-10-28T10:40:00Z",
        fixTaskId: null,
      },
      {
        now: "2026-10-29T10:00:00Z",
        pipeline: { mode: "auto" },
        production: {
          id: "env-prod",
          projectId: "prj-aud",
          name: "Production",
          kind: "production",
          url: null,
          serverCode: "SRV-1",
          reportedSha: "0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c",
          reportedAt: "2026-10-29T09:00:00Z",
        },
      },
    ).kind;
    expect(customerStatus(converted, [task({ claude: "done" })], [kind])).toBe("released");
  });
  it("task chiusa con un rilascio non ancora riuscito → in_progress", () => {
    const closed = task({ claude: "done", closedAt: "2026-10-28T12:00:00Z" });
    expect(customerStatus(converted, [closed], ["running"])).toBe("in_progress");
  });
});
