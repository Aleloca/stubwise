import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { isoWeek, TODAY } from "@backend/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { clearToasts } from "../../../tasks-ui/Toast";
import { setAppClientForTests } from "./client";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  serverTask,
  STATUS_TODO,
  TICKET_ID,
} from "./fakeServer";
import { presentInboxItem } from "./notifications";
import { listDayArrangements, planTask, setDay } from "./planning";
import { getSessionPerson } from "./session";
import { createTask, forgetTaskCodes, listTasks, updateTask } from "./tasks";

// La pianificazione della build app (integrazione area 2, fetta 2, Task F):
// `planTask`, `setDay` e le sistemazioni per giorno parlano col server, e chi
// può spostare una task lo dice `canPlan` della vista, non il client.
vi.mock("@backend/api", async () => await import("./index"));

const OTHER = "55555555-5555-4555-8555-555555555555";
// La settimana corrente dell'orologio della build (nei test, quello del seed).
const WEEK = isoWeek(TODAY);
/** «W46» come lo mostra il menu (la settimana senza l'anno). */
const SHORT = WEEK.slice(5);

type Route = Parameters<typeof installFakeServer>[0][string];

function server(routes: Record<string, Route> = {}, perms = ["tickets.edit", "planning.others"]) {
  return installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: perms } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, OTHER] })] },
    [`GET /api/projects/${PROJECT_ID}/members`]: { body: [] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada Rossi", initials: "AR", departmentIds: [DEPT_ID], email: "ada@example.com" },
        { id: OTHER, name: "Bruno Neri", initials: "BN", departmentIds: [DEPT_ID], email: "bruno@example.com" },
      ],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [serverTask({ canPlan: true })], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    [`GET /api/projects/${PROJECT_ID}/statuses`]: {
      body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/milestones": { body: [] },
    "GET /api/me/day-arrangements": { body: [] },
    ...routes,
  });
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetTaskCodes();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

afterEach(() => {
  clearToasts();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const chip = (code: string) => screen.findByRole("button", { name: new RegExp(`^${code} `) });
const placesOf = (code: string) =>
  [...document.querySelectorAll(`[data-chip="${code}"]`)].map((el) =>
    el.closest("[data-pool]") ? "pool" : (el.closest<HTMLElement>("[data-person]")?.dataset.person ?? null),
  );

describe("le scritture della pianificazione", () => {
  it("toTask legge settimana, slittamento e canPlan dal server", async () => {
    server({
      "GET /api/tasks": {
        body: { items: [serverTask({ plannedWeek: WEEK, slipCount: 2, canPlan: false })], truncated: false },
      },
    });
    const [task] = await listTasks();
    expect(task).toMatchObject({ plannedWeek: WEEK, slipCount: 2, canPlan: false });
  });

  it("un server vecchio senza canPlan: il campo resta assente", async () => {
    installFakeServer({ "GET /api/tasks": { body: { items: [serverTask()], truncated: false } } });
    const [task] = await listTasks();
    expect(task).not.toHaveProperty("canPlan");
  });

  it("planTask manda persona e settimana alla rotta plan", async () => {
    const { seen } = server({
      [`POST /api/tasks/${TICKET_ID}/plan`]: { body: serverTask({ assigneeId: OTHER, plannedWeek: WEEK }) },
    });
    const task = await planTask(TICKET_ID, { assigneeId: OTHER, week: WEEK });
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: { assigneeId: OTHER, week: WEEK } });
    expect(task).toMatchObject({ assigneeId: OTHER, plannedWeek: WEEK });
  });

  it("la settimana entra in updateTask e in createTask", async () => {
    const { seen } = server({
      [`PATCH /api/tasks/${TICKET_ID}`]: { body: serverTask({ plannedWeek: WEEK }) },
      "POST /api/tasks": { body: serverTask({ plannedWeek: WEEK }) },
    });
    await updateTask(TICKET_ID, { plannedWeek: WEEK });
    expect(seen.at(-1)).toMatchObject({ method: "PATCH", body: { plannedWeek: WEEK } });
    await createTask({ projectId: PROJECT_ID, title: "New", plannedWeek: WEEK });
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: { plannedWeek: WEEK } });
  });

  it("setDay di una task non mia non parte", async () => {
    const { seen } = server({
      "GET /api/tasks": { body: { items: [serverTask({ assigneeId: OTHER, plannedWeek: WEEK })], truncated: false } },
      [`PUT /api/tasks/${TICKET_ID}/day`]: { body: { taskId: TICKET_ID, week: WEEK, day: 2 } },
    });
    await getSessionPerson();
    await listTasks();
    await expect(setDay(TICKET_ID, WEEK, 2)).rejects.toThrow("forbidden");
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });

  it("setDay della mia task manda settimana e giorno; le sistemazioni sono le mie", async () => {
    const { seen } = server({
      "GET /api/tasks": { body: { items: [serverTask({ assigneeId: ME_ID, plannedWeek: WEEK })], truncated: false } },
      [`PUT /api/tasks/${TICKET_ID}/day`]: { body: { taskId: TICKET_ID, week: WEEK, day: 2 } },
      "GET /api/me/day-arrangements": { body: [{ taskId: TICKET_ID, week: WEEK, day: 2 }] },
    });
    await getSessionPerson();
    await listTasks();
    await setDay(TICKET_ID, WEEK, 2);
    expect(seen.find((r) => r.method === "PUT")).toMatchObject({ body: { week: WEEK, day: 2 } });
    expect(await listDayArrangements(WEEK)).toEqual([{ personId: ME_ID, taskId: TICKET_ID, week: WEEK, day: 2 }]);
    expect(seen.at(-1)!.path).toBe(`/api/me/day-arrangements?week=${WEEK}`);
  });
});

describe("il Planning della build app", () => {
  /** «P» sulla carta AUD-12 della vasca, poi Bruno Neri nella settimana corrente. */
  async function planToBruno() {
    const el = await chip("AUD-12");
    expect(placesOf("AUD-12")).toEqual(["pool"]);
    el.focus();
    fireEvent.keyDown(el, { key: "p" });
    const menu = await screen.findByRole("menu", { name: "Plan AUD-12" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Bruno Neri/ }));
    const weeks = await screen.findByRole("menu", { name: "Plan AUD-12 for Bruno Neri" });
    fireEvent.click(within(weeks).getByRole("menuitemradio", { name: new RegExp(`^${SHORT} `) }));
  }

  it("planTask 403 riporta indietro l'ottimistico con il messaggio del rifiuto, senza «Try again»", async () => {
    server({
      [`POST /api/tasks/${TICKET_ID}/plan`]: { status: 403, body: { code: "forbidden", message: "x" } },
    });
    renderRoute("/p/AUD/planning");
    await planToBruno();
    expect(
      await screen.findByText("You can't move AUD-12: only its assignee or someone who plans for others can."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(placesOf("AUD-12")).toEqual(["pool"]));
  });

  it("planTask 400 invalid_assignee e past_week: la loro frase", async () => {
    server({
      [`POST /api/tasks/${TICKET_ID}/plan`]: { status: 400, body: { code: "invalid_assignee", message: "x" } },
    });
    renderRoute("/p/AUD/planning");
    await planToBruno();
    expect(await screen.findByText("AUD-12 can only go to a member of its project.")).toBeInTheDocument();
    cleanup();
    clearToasts();
    server({
      [`POST /api/tasks/${TICKET_ID}/plan`]: { status: 400, body: { code: "past_week", message: "x" } },
    });
    renderRoute("/p/AUD/planning");
    await planToBruno();
    expect(await screen.findByText("AUD-12 can't be planned in a week that's over.")).toBeInTheDocument();
  });

  it("un errore del server che non è un rifiuto: il messaggio di prima e «Try again»", async () => {
    server({
      [`POST /api/tasks/${TICKET_ID}/plan`]: { status: 500, body: { code: "internal", message: "x" } },
    });
    renderRoute("/p/AUD/planning");
    await planToBruno();
    expect(await screen.findByText("Couldn't move AUD-12. It's back where it was.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("setDay 409 not_in_week: la sua frase", async () => {
    server({
      "GET /api/tasks": { body: { items: [serverTask({ assigneeId: ME_ID, plannedWeek: WEEK })], truncated: false } },
      [`PUT /api/tasks/${TICKET_ID}/day`]: { status: 409, body: { code: "not_in_week", message: "x" } },
    });
    renderRoute("/home?view=week");
    const card = await screen.findByRole("button", { name: /^AUD-12 / });
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "ArrowRight" });
    fireEvent.keyDown(card, { key: " " });
    expect(await screen.findByText("AUD-12 isn't in this week any more.")).toBeInTheDocument();
  });

  it("canPlan del server decide la sola lettura", async () => {
    // Chi guarda ha planning.others qui, ma il server dice che QUESTA task no.
    server({
      "GET /api/tasks": {
        body: {
          items: [
            serverTask({ assigneeId: OTHER, plannedWeek: WEEK, canPlan: false }),
            serverTask({
              id: "77777777-7777-4777-8777-777777777777",
              ticketId: "77777777-7777-4777-8777-777777777777",
              code: "AUD-13",
              number: 13,
              title: "Second",
              assigneeId: OTHER,
              plannedWeek: WEEK,
              canPlan: true,
            }),
          ],
          truncated: false,
        },
      },
    });
    renderRoute("/p/AUD/planning");
    const locked = await chip("AUD-12");
    locked.focus();
    fireEvent.keyDown(locked, { key: "p" });
    expect(screen.queryByRole("menu")).toBeNull();
    const free = await chip("AUD-13");
    free.focus();
    fireEvent.keyDown(free, { key: "p" });
    expect(await screen.findByRole("menu", { name: "Plan AUD-13" })).toBeInTheDocument();
  });

  it("troncato: l'avviso compare", async () => {
    server({
      "GET /api/tasks": { body: { items: [serverTask({ assigneeId: ME_ID, plannedWeek: WEEK })], truncated: true } },
    });
    renderRoute("/home?view=week");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
  });
});

describe("gli avvisi della pianificazione", () => {
  it("planning.changed e task.assigned aprono il pannello della task", () => {
    const ctx = { taskCodes: new Map([[TICKET_ID, "AUD-12"]]), projectCodes: new Map([[PROJECT_ID, "AUD"]]) };
    for (const kind of ["planning.changed", "task.assigned"]) {
      const card = presentInboxItem(
        {
          id: "88888888-8888-4888-8888-888888888888",
          kind,
          status: "open",
          text: "AUD-12 moved",
          actions: [],
          projectId: PROJECT_ID,
          ticketId: TICKET_ID,
          createdAt: "2026-10-23T10:00:00.000Z",
          readAt: null,
        } as never,
        ctx,
      );
      expect(card.link).toBe("#/p/AUD/tasks?task=AUD-12");
      expect(card).not.toHaveProperty("webHref");
    }
  });
});

describe("il feed della task nella build app", () => {
  it("chi o cosa non esiste più non mostra mai un id; null resta «tolto»", async () => {
    const gone = "00000000-0000-4000-8000-0000000000aa";
    const entry = (n: number, field: string, from: string | null, to: string | null) => ({
      id: `00000000-0000-4000-8000-00000000010${n}`,
      taskId: TICKET_ID,
      kind: "field_change",
      authorId: null,
      at: `2026-10-2${n}T10:00:00.000Z`,
      field,
      from,
      to,
    });
    server({
      "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
      [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: "none", pullRequests: [], webHref: `/tickets/${TICKET_ID}` } },
      [`GET /api/tasks/${TICKET_ID}/activity`]: {
        body: [
          entry(1, "assignee", gone, "Ada Rossi"),
          entry(2, "milestone", gone, null),
          entry(3, "department", "General", gone),
        ],
      },
    });
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog");
    expect(await within(panel).findByText(/assignee: someone → Ada Rossi/i)).toBeInTheDocument();
    expect(within(panel).getByText(/milestone cleared/i)).toBeInTheDocument();
    expect(within(panel).getByText(/department: General → a deleted department/i)).toBeInTheDocument();
    expect(panel.textContent).not.toContain(gone);
  });
});
