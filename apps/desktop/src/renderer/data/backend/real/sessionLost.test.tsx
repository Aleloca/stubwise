import { focusManager } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, PROJECT_ID, serverProject } from "./fakeServer";

// L'app intera sulla build app vera: `@backend/api` è l'implementazione vera
// (non il finto dei test), davanti a un server finto. Review Focus 3 del
// piano: persona cambiata o sessione scaduta a metà.
vi.mock("@backend/api", async () => await import("./index"));

const PROJECT = serverProject();

let signedIn = true;
const authed = (body: unknown) => () =>
  signedIn ? { body } : { status: 401, body: { code: "unauthenticated", message: "x" } };

beforeEach(() => {
  signedIn = true;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    "GET /api/auth/me": authed(me()),
    "GET /api/projects": authed([PROJECT]),
    [`GET /api/projects/${PROJECT_ID}/members`]: authed([]),
    "GET /api/me/follows": authed({ projectIds: [PROJECT_ID] }),
    "GET /api/decisions": authed([]),
    "GET /api/inbox": authed({ items: [], nextCursor: null }),
    "GET /api/people": authed([]),
    "GET /api/departments": authed([]),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("sessione nella build app", () => {
  it("fuori, l'app porta al login", async () => {
    signedIn = false;
    const router = renderRoute("/projects");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("un 401 a metà porta al login e svuota la cache", async () => {
    const router = renderRoute("/projects");
    // Dentro: la tessera del progetto fissato è nel binario.
    expect(await screen.findByRole("link", { name: /Audin AI/ })).toBeInTheDocument();
    signedIn = false;
    // Il server ora risponde 401: la prima rilettura (al ritorno del fuoco) lo scopre.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    // Nessun dato della sessione di prima a schermo.
    expect(screen.queryByRole("link", { name: /Audin AI/ })).toBeNull();
    expect(screen.queryByText("Audin AI")).toBeNull();
    focusManager.setFocused(undefined);
  });
});
