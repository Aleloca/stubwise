import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../App";
import { render } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, serverProject } from "./fakeServer";

// Avvio offline o server giù (review del renderer, punto 7): «non
// raggiungibile» non è «fuori». Niente ingresso, niente schermata bianca: una
// frase e «Retry».
const viewerFails = vi.hoisted(() => ({ on: false }));
vi.mock("@backend/api", async () => {
  const real = await import("./index");
  return {
    ...real,
    getViewer: async () => {
      if (viewerFails.on) throw new Error("viewer failed");
      return real.getViewer();
    },
  };
});

let meStatus = 503;

beforeEach(() => {
  meStatus = 503;
  viewerFails.on = false;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    "GET /api/auth/me": () =>
      meStatus !== 200 ? { status: meStatus, body: { code: "unavailable", message: "x" } } : { body: me() },
    "GET /api/projects": { body: [serverProject()] },
    [`GET /api/projects/${serverProject().id}/members`]: { body: [] },
    "GET /api/me/follows": { body: { projectIds: [] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": { body: [] },
    "GET /api/departments": { body: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const mount = (path = "/projects") => {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<App history={history} />);
  return history;
};

describe("Stubwise non raggiungibile", () => {
  it("un 5xx su /me mostra l'errore con Retry, non l'ingresso; Retry riprova", async () => {
    const ue = userEvent.setup();
    const history = mount();
    expect(await screen.findByText("Couldn't reach Stubwise")).toBeInTheDocument();
    expect(history.location.pathname).toBe("/projects");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    meStatus = 200;
    await ue.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Couldn't reach Stubwise")).toBeNull());
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });

  it("un errore di rete su /me dà lo stesso stato", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("offline");
    }));
    mount();
    expect(await screen.findByText("Couldn't reach Stubwise")).toBeInTheDocument();
  });

  it("getViewer che fallisce dopo un /me riuscito: errore con Retry, non una schermata bianca", async () => {
    meStatus = 200;
    viewerFails.on = true;
    mount();
    expect(await screen.findByText("Couldn't reach Stubwise")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("una sola lettura di /api/auth/me", () => {
  it("chi è dentro e i suoi permessi vengono dalla stessa risposta", async () => {
    meStatus = 200;
    mount();
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => String(c[0]) === "/api/auth/me",
    );
    expect(calls).toHaveLength(1);
  });
});
