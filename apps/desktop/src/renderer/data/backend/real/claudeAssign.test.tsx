import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { listPeople } from "./people";
import { forgetTaskCodes } from "./tasks";

// Claude assegnabile nella build app (integrazione area 3, 3e.2): Claude è la
// riga di `/api/people` con `isClaude`, e si assegna SOLO nei progetti che la
// sua riga elenca in `claudeAssignableProjectIds` (calcolati dal server da
// `runs.start` di chi guarda). Non è un membro del progetto: `memberIds` non
// lo contiene mai.
vi.mock("@backend/api", async () => await import("./index"));

const CLAUDE = "99999999-9999-4999-8999-999999999999";
const WEEK = isoWeek(TODAY);
const SHORT = WEEK.slice(5);

type Route = Parameters<typeof installFakeServer>[0][string];

function server(assignable: string[], routes: Record<string, Route> = {}) {
  return installFakeServer({
    "GET /api/auth/me": {
      body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.edit", "planning.others", "runs.start"] } }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    [`GET /api/projects/${PROJECT_ID}/members`]: { body: [] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada Rossi", initials: "AR", departmentIds: [DEPT_ID], email: "ada@example.com" },
        {
          id: CLAUDE,
          name: "Claude",
          initials: "C",
          departmentIds: [],
          email: "claude@stubwise.invalid",
          isClaude: true,
          claudeAssignableProjectIds: assignable,
        },
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
    "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
    [`GET /api/tasks/${TICKET_ID}/activity`]: { body: [] },
    [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: null, pullRequests: [], webHref: `/tickets/${TICKET_ID}` } },
    ...routes,
  });
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetTaskCodes();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const chip = (code: string) => screen.findByRole("button", { name: new RegExp(`^${code} `) });
const rowIds = () => [...document.querySelectorAll<HTMLElement>("[data-person]")].map((el) => el.dataset.person);

async function openPlanMenu() {
  const el = await chip("AUD-12");
  el.focus();
  fireEvent.keyDown(el, { key: "p" });
  return screen.findByRole("menu", { name: "Plan AUD-12" });
}

describe("Claude dalla riga di /api/people", () => {
  it("toPerson legge isClaude e i progetti dove si può assegnare", async () => {
    server([PROJECT_ID]);
    const people = await listPeople();
    expect(people.find((p) => p.id === CLAUDE)).toMatchObject({ isClaude: true, assignableProjectIds: [PROJECT_ID] });
    expect(people.find((p) => p.id === ME_ID)).toMatchObject({ isClaude: false });
  });
});

describe("il Planning con Claude", () => {
  it("dove si può assegnare: la sua riga e la sua voce nel menu «Plan», per ultimo", async () => {
    server([PROJECT_ID]);
    renderRoute("/p/AUD/planning");
    const menu = await openPlanMenu();
    const items = within(menu).getAllByRole("menuitemradio").map((el) => el.textContent ?? "");
    expect(items.at(-1)).toMatch(/Claude/);
    await waitFor(() => expect(rowIds()).toContain(CLAUDE));
    expect(rowIds().at(-1)).toBe(CLAUDE);
  });

  it("dove chi guarda non può assegnarlo (niente runs.start): né riga né voce", async () => {
    server([]);
    renderRoute("/p/AUD/planning");
    const menu = await openPlanMenu();
    expect(within(menu).queryByRole("menuitemradio", { name: /Claude/ })).toBeNull();
    expect(rowIds()).not.toContain(CLAUDE);
  });

  it("un 403 claude_assign_forbidden ha la sua frase, senza «Try again»", async () => {
    server([PROJECT_ID], {
      [`POST /api/tasks/${TICKET_ID}/plan`]: { status: 403, body: { code: "claude_assign_forbidden", message: "x" } },
    });
    renderRoute("/p/AUD/planning");
    const menu = await openPlanMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Claude/ }));
    const weeks = await screen.findByRole("menu", { name: "Plan AUD-12 for Claude" });
    fireEvent.click(within(weeks).getByRole("menuitemradio", { name: new RegExp(`^${SHORT} `) }));
    expect(
      await screen.findByText("You can't give AUD-12 to Claude: only someone who can start Claude's work in this project can."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("assegnare Claude dalla task", () => {
  it("il menu dell'assegnatario lo offre dove si assegna; un 403 claude_assign_forbidden ha la sua frase", async () => {
    const { seen } = server([PROJECT_ID], {
      [`PATCH /api/tasks/${TICKET_ID}`]: { status: 403, body: { code: "claude_assign_forbidden", message: "x" } },
    });
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    await userEvent.click(await within(panel).findByRole("button", { name: /^Assignee: .*Change$/ }));
    const people = await screen.findByRole("menu", { name: "Assignee of AUD-12" });
    await userEvent.click(within(people).getByRole("menuitemradio", { name: /Claude/ }));
    await waitFor(() => expect(seen.some((r) => r.method === "PATCH")).toBe(true));
    expect(seen.find((r) => r.method === "PATCH")).toMatchObject({ body: { assigneeId: CLAUDE } });
    expect(
      await screen.findByText("You can't give AUD-12 to Claude: only someone who can start Claude's work in this project can."),
    ).toBeInTheDocument();
  });
});

describe("assegnare Claude in blocco", () => {
  it("un 403 claude_assign_forbidden del blocco ha la sua frase", async () => {
    const { seen } = server([PROJECT_ID], {
      "PATCH /api/tasks/bulk": { status: 403, body: { code: "claude_assign_forbidden", message: "x", codes: [] } },
    });
    renderRoute("/p/AUD/tasks");
    const user = userEvent.setup();
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-task-row="AUD-12"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await user.keyboard("{Meta>}");
    await user.click(within(row).getByRole("button", { name: /^AUD-12(?!\d)/ }));
    await user.keyboard("{/Meta}");
    const bar = await screen.findByRole("region", { name: "Change the selected tasks" });
    await user.click(within(bar).getByRole("button", { name: /Assignee/ }));
    const menu = await screen.findByRole("menu", { name: "Assignee" });
    await user.click(within(menu).getByRole("menuitemradio", { name: /Claude/ }));
    await waitFor(() => expect(seen.some((r) => r.method === "PATCH" && r.path === "/api/tasks/bulk")).toBe(true));
    expect(
      await screen.findByText(
        "You can't give 1 task to Claude: only someone who can start Claude's work in its project can. It's back as it was.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Claude sulle carte", () => {
  it("una task assegnata a Claude lo mostra col suo anello, anche a chi non può assegnarlo", async () => {
    server([], {
      "GET /api/tasks": { body: { items: [serverTask({ assigneeId: CLAUDE, claude: "working" })], truncated: false } },
    });
    renderRoute("/p/AUD/tasks");
    const chipOf = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-task-row="AUD-12"] [data-person="${CLAUDE}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chipOf.querySelector("[data-claude-ring]")).not.toBeNull();
    expect(chipOf).toHaveAttribute("title", "Claude");
  });
});
