import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, serverProject, type SeenRequest } from "./fakeServer";

// Amministrazione → Reparti, eliminazione (review del renderer, punto 8): il
// conteggio delle task si legge all'apertura del dialogo, filtrato per reparto.
vi.mock("@backend/api", async () => await import("./index"));
// Anche i fatti sugli accessi sono quelli della build app (dal Viewer del server).
vi.mock("@backend/access", async () => await import("./accessFacts"));

const GENERAL = "66666666-6666-4666-8666-666666666666";
const SALES = "77777777-7777-4777-8777-777777777777";
let tasksReply: { status?: number; body: unknown } = { body: { items: [{}, {}], truncated: false } };
let seen: SeenRequest[] = [];

beforeEach(() => {
  tasksReply = { body: { items: [{}, {}], truncated: false } };
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ instancePermissions: ["departments.manage"] }) },
    "GET /api/projects": { body: [serverProject()] },
    "GET /api/me/follows": { body: { projectIds: [] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [SALES], email: "ada@example.com" }],
    },
    "GET /api/departments/roles": { body: [] },
    "GET /api/departments": {
      body: [
        { id: GENERAL, name: "General", colorToken: "--dept-1", isDefault: true },
        { id: SALES, name: "Sales", colorToken: "--dept-2", isDefault: false },
      ],
    },
    "GET /api/tasks": () => tasksReply,
  }).seen;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

async function openDelete() {
  const ue = userEvent.setup();
  renderRoute(`/admin/departments?department=${SALES}`);
  await ue.click(await screen.findByRole("button", { name: "Delete department…" }));
  return { ue, dialog: await screen.findByRole("dialog", { name: "Delete Sales?" }) };
}

describe("eliminare un reparto nella build app", () => {
  it("l'elenco non conta le task; il dialogo le conta, filtrate per reparto", async () => {
    const { dialog } = await openDelete();
    expect(await within(dialog).findByText(/2 tasks have Sales/)).toBeInTheDocument();
    const counts = seen.filter((r) => r.path.startsWith("/api/tasks"));
    expect(counts).toHaveLength(1);
    expect(new URLSearchParams(counts[0]!.path.split("?")[1]).get("departmentIds")).toBe(SALES);
  });

  it("oltre il tetto dice «più di»", async () => {
    tasksReply = { body: { items: Array.from({ length: 2000 }, () => ({})), truncated: true } };
    const { dialog } = await openDelete();
    expect(await within(dialog).findByText(/More than 2000 tasks have Sales/)).toBeInTheDocument();
  });

  it("un errore del conteggio è un errore, non zero task", async () => {
    tasksReply = { status: 500, body: { code: "internal", message: "x" } };
    const { dialog } = await openDelete();
    expect(await within(dialog).findByText("Couldn't count the tasks of this department.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
