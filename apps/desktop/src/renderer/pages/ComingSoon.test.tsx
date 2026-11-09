import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../test/renderRoute";

// Le aree non integrate nella build app (integrazione area 2, fetta 1): restano
// nella navigazione con «Coming soon» e non leggono niente. Nei test il livello
// dati è il finto anche con `VITE_STUBWISE_BUILD=app`: qui si registra ogni
// chiamata ai namespace delle aree future, che devono restare a zero.
const { FUTURE_NAMESPACES, calls, truncated } = vi.hoisted(() => ({
  calls: [] as string[],
  // Il finto non tronca mai: qui si finge la risposta del server oltre le 2000 righe.
  truncated: { value: false },
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
    if (name === "tasksTruncated") {
      wrapped[name] = record(name, () => truncated.value);
    } else if (typeof value === "function") {
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
const { setSessionPersonId } = await import("../data/session");

/** Nella build app la persona è quella della sessione (il finto), non quella di `renderRoute`. */
function signedInAs(personId: string) {
  setSessionPersonId(personId);
}

beforeEach(() => {
  setLatency(0);
  calls.length = 0;
  truncated.value = false;
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
  "getTaskWorkSummary",
  "listProjectStatuses",
  "listMilestones",
  "getRequest",
  // Fetta 2: settimana, Planning, La mia settimana, Timeline.
  "listDayArrangements",
  "planTask",
  "setDay",
  "tasksTruncated",
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
    renderRoute("/p/AUD/docs");
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  // Dal Task 17 la sezione Claude dice lo stato vero (e «Open in web» nel web vecchio).
  it("nel dettaglio della task la sezione Claude dice lo stato, senza azioni dell'area 3 né «Delete»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/tasks?task=AUD-9");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-9" });
    const claude = await within(panel).findByRole("region", { name: "Claude" });
    const states = ["Claude isn't working on this task.", "Claude is working on it.", "Claude asked a question and is waiting for an answer.", "Claude is waiting for its plan to be approved.", "Claude stopped. Someone needs to look at it.", "Claude finished its work.", "Claude is waiting for the queue to resume."];
    expect(await within(claude).findByText((text) => states.includes(text))).toBeInTheDocument();
    expect(within(claude).queryByText("Coming soon")).toBeNull();
    expect(within(claude).queryByRole("button", { name: /Assign to Claude|Start/ })).toBeNull();
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

describe("le superfici della fetta 2 nella build app", () => {
  it("dopo il login si atterra su La mia settimana", async () => {
    const router = renderRoute("/login");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(router.state.location.search).toMatchObject({ view: "week" });
    expect(await screen.findByRole("heading", { level: 1, name: "My week" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("l'indirizzo vuoto atterra su La mia settimana", async () => {
    const router = renderRoute("/");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: "week" }));
    expect(router.state.location.pathname).toBe("/home");
  });

  it("/home senza view resta Coming soon", async () => {
    renderRoute("/home");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("la colonna della Home non legge i filtri salvati", async () => {
    signedInAs("p-laura");
    renderRoute("/home?view=week");
    const nav = await screen.findByRole("navigation", { name: "Home views" });
    expect(await within(nav).findByRole("link", { name: "Planning" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "My week" })).toBeInTheDocument();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("/planning senza planning.others torna a My week", async () => {
    signedInAs("p-marco");
    const router = renderRoute("/planning");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: "week" }));
    expect(router.state.location.pathname).toBe("/home");
  });

  it("il Planning trasversale c'è per chi ha planning.others, senza la riga di Claude", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: /Claude/ })).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("il Planning di progetto è disponibile", async () => {
    signedInAs("p-laura");
    renderRoute("/p/AUD/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await settle();
    expect(outside()).toEqual([]);
  });

  it("troncato: l'avviso compare nel Planning e in La mia settimana", async () => {
    signedInAs("p-laura");
    renderRoute("/planning");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.queryByText("Some tasks are missing from the load.")).toBeNull();
    cleanup();
    truncated.value = true;
    renderRoute("/planning");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
    cleanup();
    renderRoute("/home?view=week");
    expect(await screen.findByText("Some tasks are missing from the load.")).toBeInTheDocument();
  });

  it("la Timeline è disponibile", async () => {
    renderRoute("/p/AUD/tasks?view=timeline");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(outside()).toEqual([]);
  });
});
