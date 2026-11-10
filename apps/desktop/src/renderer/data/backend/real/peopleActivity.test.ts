import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, ME_ID, PROJECT_ID, TICKET_ID } from "./fakeServer";
import { listDailyReports, listPeopleActivity } from "./peopleActivity";

// «By person» di Activity nella build app (integrazione area 3, fetta 3d): lo
// standup aggregato dal server, solo dei progetti che chi guarda vede, con
// `people.activity.view`; i report giornalieri dalla Daily Activity Report.

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("l'attività per persona dal server", () => {
  it("la forma del prototipo; il giorno e il reparto nella query; un autore non collegato senza persona", async () => {
    const { seen } = installFakeServer({
      "GET /api/people/activity": {
        body: [
          {
            personId: ME_ID,
            name: "Ada",
            departmentIds: [DEPT_ID],
            tasksClosed: [{ taskId: TICKET_ID, code: "AUD-12", title: "Export", projectId: PROJECT_ID, at: "2026-11-10T09:00:00.000Z" }],
            comments: [{ id: "eeeeeeee-0000-4000-8000-000000000001", taskId: TICKET_ID, code: "AUD-12", projectId: PROJECT_ID, body: "Done", at: "2026-11-10T09:05:00.000Z" }],
          },
          {
            personId: null,
            name: "bot@ci.example",
            commits: [
              { sha: "abc", repo: "acme/app", authorId: null, authorName: "bot@ci.example", message: "chore", aiSummary: "Bumps deps", at: "2026-11-10T08:00:00.000Z", projectId: PROJECT_ID },
            ],
          },
        ],
      },
    });
    const rows = await listPeopleActivity("2026-11-10", DEPT_ID);
    expect(new URLSearchParams(seen[0]!.path.split("?")[1]).get("date")).toBe("2026-11-10");
    expect(new URLSearchParams(seen[0]!.path.split("?")[1]).get("departmentId")).toBe(DEPT_ID);
    expect(rows[0]).toMatchObject({
      personId: ME_ID,
      tasksClosed: [{ code: "AUD-12" }],
      tasksMoved: [],
      tasksDeleted: [],
      comments: [{ body: "Done", viaClaude: false }],
      decisions: [],
      requestsCreated: [],
      commits: [],
    });
    expect(rows[1]).toMatchObject({ personId: null, name: "bot@ci.example", departmentIds: [], commits: [{ aiSummary: "Bumps deps" }] });
  });

  it("senza il permesso: un rifiuto, come nel prototipo", async () => {
    installFakeServer({ "GET /api/people/activity": { status: 403, body: { code: "forbidden", message: "x" } } });
    await expect(listPeopleActivity("2026-11-10")).rejects.toThrow("forbidden");
  });

  it("i report del giorno: fatti o falliti, coi commit arrivati dopo; quelli in coda non ci sono ancora", async () => {
    installFakeServer({
      "GET /api/activity": {
        body: {
          date: "2026-11-10",
          projects: [
            { project: { id: PROJECT_ID, name: "Audin", slug: "audin" }, status: "done", summary: "Shipped the export.", staleCommitCount: 2 },
            { project: { id: "22222222-2222-4222-8222-222222222223", name: "B", slug: "b" }, status: "failed", summary: null },
            { project: { id: "22222222-2222-4222-8222-222222222224", name: "C", slug: "c" }, status: "queued", summary: null },
          ],
        },
      },
    });
    expect(await listDailyReports("2026-11-10")).toEqual([
      { id: `${PROJECT_ID}:2026-11-10`, projectId: PROJECT_ID, date: "2026-11-10", summary: "Shipped the export.", generatedAt: null, newCommits: 2 },
      { id: "22222222-2222-4222-8222-222222222223:2026-11-10", projectId: "22222222-2222-4222-8222-222222222223", date: "2026-11-10", summary: null, generatedAt: null, newCommits: 0 },
    ]);
  });
});
