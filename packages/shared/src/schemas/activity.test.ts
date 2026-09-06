import { describe, expect, it } from "vitest";
import { activityForDateSchema } from "./activity.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("activityForDateSchema", () => {
  it("legge date + il riassunto di ogni progetto, ignorando gli altri campi della risposta", () => {
    // Forma VERA di GET /api/activity: molto più ricca di ciò che questo
    // schema dichiara (header, commits, developers…). Zod la spoglia — è il
    // comportamento che questo test sorveglia, non un dettaglio incidentale.
    const raw = {
      date: "2026-09-01",
      projects: [
        {
          project: { id: PROJECT_ID, name: "Portale B2B", slug: "portale-b2b" },
          status: "done",
          summary: "Sistemato il checkout, 3 commit.",
          staleCommitCount: 0,
          header: { commitCount: 3, additions: 40, deletions: 5, authorCount: 1 },
          commits: [{ sha: "abc" }],
        },
      ],
      developers: [{ resolvedUser: null }],
      developersSummaryPending: false,
      staleCommitTotal: 0,
    };

    const parsed = activityForDateSchema.parse(raw);
    expect(parsed).toEqual({
      date: "2026-09-01",
      projects: [
        {
          project: { id: PROJECT_ID, name: "Portale B2B", slug: "portale-b2b" },
          status: "done",
          summary: "Sistemato il checkout, 3 commit.",
        },
      ],
    });
  });

  it("accetta un riassunto null (report non ancora sintetizzato)", () => {
    const parsed = activityForDateSchema.parse({
      date: "2026-09-01",
      projects: [{ project: { id: PROJECT_ID, name: "X", slug: "x" }, status: "queued", summary: null }],
    });
    expect(parsed.projects[0]!.summary).toBeNull();
  });

  it("un giorno senza report ha una lista progetti vuota", () => {
    const parsed = activityForDateSchema.parse({ date: "2026-09-01", projects: [] });
    expect(parsed.projects).toEqual([]);
  });
});
