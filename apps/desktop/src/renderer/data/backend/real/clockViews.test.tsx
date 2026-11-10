import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { advanceClock } from "./clock";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask } from "./fakeServer";

// Le viste della build app seguono l'orologio vero (fix della fetta 2): al
// cambio di giorno la settimana corrente si aggiorna senza ricaricare, e al
// cambio di settimana le task si rileggono.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("@backend/clock", async () => await import("./clock"));

let taskReads = 0;
let stalledReads = 0;
let toConvertReads = 0;

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  taskReads = 0;
  stalledReads = 0;
  toConvertReads = 0;
  // Sabato 14 novembre 2026: settimana W46.
  advanceClock(new Date("2026-11-14T10:00:00Z"));
  installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": () => {
      taskReads++;
      return {
        body: {
          items: [serverTask({ assigneeId: ME_ID, plannedWeek: "2026-W47", dueDate: "2026-11-17" })],
          truncated: false,
        },
      };
    },
    "GET /api/tasks/stalled": () => {
      stalledReads++;
      return { body: [] };
    },
    [`GET /api/projects/${PROJECT_ID}/statuses`]: {
      body: [{ id: "99999999-9999-4999-8999-999999999991", projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/me/day-arrangements": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/filters": { body: [] },
    "GET /api/requests/to-convert": () => {
      toConvertReads++;
      return { body: [] };
    },
    [`GET /api/projects/${PROJECT_ID}/decisions`]: { body: [] },
    [`GET /api/projects/${PROJECT_ID}/briefs/latest`]: { body: null },
    [`GET /api/projects/${PROJECT_ID}/chronology`]: { body: { events: [], nextBefore: null } },
    "GET /api/me/pinned-filters": { body: [] },
  });
});

afterEach(() => {
  // Prima si smonta: riportare l'orologio a oggi ridisegnerebbe un albero ancora montato.
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
  advanceClock(new Date());
});

describe("le viste e l'orologio", () => {
  it("al cambio di giorno le viste si aggiornano", async () => {
    renderRoute("/home?view=week");
    expect(await screen.findByText("Nothing planned for you this week")).toBeInTheDocument();
    const before = taskReads;
    // Lunedì 16: la task della W47 è di questa settimana, e la vista non è in sola lettura.
    act(() => advanceClock(new Date("2026-11-16T07:00:00Z")));
    expect(await screen.findByRole("button", { name: /^AUD-12 / })).toBeInTheDocument();
    expect(screen.queryByText(/read-only|only look/i)).toBeNull();
    expect(taskReads).toBeGreaterThan(before);
  });

  it("al cambio di giorno «In ritardo» si aggiorna, e task e ferme si rileggono", async () => {
    renderRoute("/p/AUD/tasks");
    // Lunedì 16 novembre (settimana nuova): la scadenza del 17 è domani.
    act(() => advanceClock(new Date("2026-11-16T09:00:00Z")));
    expect(await screen.findByText(/^Due /)).toBeInTheDocument();
    await waitFor(() => expect(taskReads).toBeGreaterThan(0));
    const before = { tasks: taskReads, stalled: stalledReads };
    // Mercoledì 18, stessa settimana: è passata.
    act(() => advanceClock(new Date("2026-11-18T09:00:00Z")));
    expect(await screen.findByText(/^Overdue, due /)).toBeInTheDocument();
    await waitFor(() => expect(stalledReads).toBeGreaterThan(before.stalled));
    expect(taskReads).toBeGreaterThan(before.tasks);
  });

  it("al cambio di giorno si rilegge anche il polso (le ferme e «in ritardo» cambiano col giorno)", async () => {
    renderRoute("/p/AUD/overview");
    await waitFor(() => expect(toConvertReads).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const before = toConvertReads;
    // Domenica 15, stessa settimana.
    act(() => advanceClock(new Date("2026-11-15T09:00:00Z")));
    await waitFor(() => expect(toConvertReads).toBeGreaterThan(before));
  });
});
