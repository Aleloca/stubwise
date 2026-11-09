import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../test/renderRoute";

// Le aree non integrate nella build app (integrazione area 2, fetta 1): restano
// nella navigazione con «Coming soon» e non leggono niente. Nei test il livello
// dati è il finto anche con `VITE_STUBWISE_BUILD=app`: qui si registra ogni
// chiamata ai namespace delle aree future, che devono restare a zero.
const { FUTURE_NAMESPACES, calls } = vi.hoisted(() => ({
  calls: [] as string[],
  FUTURE_NAMESPACES: [
    "auth",
    "admin",
    "me",
    "projectSettings",
  "chat",
  "docs",
  "productDocs",
  "drive",
  "mail",
  "calendar",
  "automations",
  "alerts",
  "releases",
  "support",
  "servers",
  "changelog",
  "access",
  "claude",
  "instance",
  ] as const,
}));

vi.mock("@backend/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  const record = (name: string, fn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push(name);
      return fn(...args);
    };
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function") {
      wrapped[name] = record(name, value as (...a: unknown[]) => unknown);
    } else if (value && typeof value === "object" && FUTURE_NAMESPACES.includes(name as never)) {
      wrapped[name] = new Proxy(value as Record<string, unknown>, {
        get(t, key) {
          const v = t[key as string];
          if (typeof key !== "string" || typeof v !== "function") return v;
          return record(`${name}.${key}`, v as (...a: unknown[]) => unknown);
        },
      });
    } else wrapped[name] = value;
  }
  return wrapped;
});

const { resetApi, setLatency } = await import("../data/api");

beforeEach(() => {
  setLatency(0);
  calls.length = 0;
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

/**
 * Ciò che la build app può chiamare: le esportazioni che i Task 16–17
 * dell'integrazione implementano sul server vero (ossatura e Tasks). Ogni
 * altra chiamata, nella build app vera, sarebbe uno stub «non integrato».
 */
const INTEGRATED_CALLS = new Set([
  // Task 16: sessione, persone, progetti, notifiche, ricerca, reparti.
  "getViewer",
  "getSessionPerson",
  "auth.readEntry",
  "auth.login",
  "auth.logout",
  "listPeople",
  "listDepartments",
  "listProjects",
  "getProjectByCode",
  "listPinnedProjectIds",
  "setPinned",
  "listWaitingOnMeProjectIds",
  "listNotifications",
  "markNotification",
  "search",
  "admin.listDepartments",
  "admin.createDepartment",
  "admin.updateDepartment",
  "admin.saveDepartment",
  "admin.deleteDepartment",
  // Task 17: Tasks, dettaglio, nuova task, stati.
  "listTasks",
  "listStalled",
  "getTaskByCode",
  "listActivity",
  "listDecisionRequests",
  "getTaskWork",
  "listProjectStatuses",
  "listMilestones",
  "getRequest",
]);

const outside = () => [...new Set(calls)].filter((c) => !INTEGRATED_CALLS.has(c));

afterEach(() => {
  vi.unstubAllEnvs();
  resetApi();
});

const MORE = "More actions for AUD-9";
const DELETE = "Delete task\u2026";

/** Lascia partire le letture della shell. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("aree non integrate nella build app", () => {
  it("aprire la Chat mostra «Coming soon» e nessuna lettura della Chat", async () => {
    renderRoute("/chat");
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("aprire un progetto atterra su Tasks", async () => {
    const router = renderRoute("/p/AUD");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/tasks"));
    await settle();
    // Le Tasks leggono solo ciò che la fetta integra (niente riga di Claude, niente blocchi dell'istanza).
    expect(outside()).toEqual([]);
  });

  it("il binario non legge i segnali delle aree future (Chat, Posta, Automations)", async () => {
    renderRoute("/projects");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("una sezione di progetto non integrata mostra «Coming soon»", async () => {
    renderRoute("/p/AUD/planning");
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("nel dettaglio della task la sezione Claude è «Coming soon», senza «Delete»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-9");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-9" });
    const claude = await within(panel).findByRole("region", { name: "Claude" });
    expect(within(claude).getByText("Coming soon")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: MORE }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.queryByText(DELETE)).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("nel prototipo la Chat resta la Chat", async () => {
    vi.unstubAllEnvs();
    renderRoute("/chat");
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });
});
