import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, serverProject, type SeenRequest } from "./fakeServer";

// L'ingresso vero del Task 21 (integrazione area 2, «Aggiunta del 9 nov 2026:
// il login»): la conferma del login del desktop su `/app` e l'ingresso del
// desktop, che passa tutto dal browser di sistema.
vi.mock("@backend/api", async () => await import("./index"));

const CHALLENGE = "a".repeat(43);
const STATE = "stato-del-desktop";
const DEVICE = "MacBook di Ada";
const LINK = `/desktop-login?challenge=${CHALLENGE}&state=${STATE}&device=${encodeURIComponent(DEVICE)}`;

const user = { id: ME_ID, email: "ada@example.com", role: "member" };
let signedIn = false;
let seen: SeenRequest[] = [];
const authed = (body: unknown) => () =>
  signedIn ? { body } : { status: 401, body: { code: "unauthenticated", message: "x" } };

const people = [
  { id: ME_ID, name: "Ada Lovelace", initials: "AL", departmentIds: [], email: "ada@example.com", deactivated: false },
];

function server(extra: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": authed(me()),
    "POST /api/auth/login": () => ({ body: { user, stage: "second_factor" } }),
    "GET /api/auth/second-factor": {
      body: { stage: "second_factor", passkeys: false, backupCodesRemaining: 8, lockedUntil: null },
    },
    "POST /api/auth/second-factor/verify": () => {
      signedIn = true;
      return { body: { user, backupCodesRemaining: 8 } };
    },
    "POST /api/auth/desktop-handoff": { body: { code: "CODICE-MONOUSO" } },
    "GET /api/me/security": authed({
      totp: { configured: true, confirmedAt: "2026-11-01T00:00:00.000Z" },
      passkeys: [],
      backupCodesRemaining: 8,
      events: [],
    }),
    "GET /api/projects": authed([serverProject()]),
    [`GET /api/projects/${serverProject().id}/members`]: authed([]),
    "GET /api/me/follows": authed({ projectIds: [] }),
    "GET /api/decisions": authed([]),
    "GET /api/inbox": authed({ items: [], nextCursor: null }),
    "GET /api/people": authed(people),
    "GET /api/departments": authed([]),
    ...extra,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

const handoffs = () => seen.filter((r) => r.method === "POST" && r.path === "/api/auth/desktop-handoff");

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  signedIn = false;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
  delete (window as { stubwise?: unknown }).stubwise;
});

describe("/app/#/desktop-login (la conferma nel browser)", () => {
  it("desktop-login senza sessione chiede prima il login, poi la conferma", async () => {
    server();
    const ue = userEvent.setup();
    renderRoute(LINK);
    expect(await screen.findByRole("heading", { name: "Sign in to Stubwise" })).toBeInTheDocument();
    expect(screen.getByText(`Sign in to let Stubwise on “${DEVICE}” use your account.`)).toBeInTheDocument();
    await ue.type(screen.getByLabelText("Email"), "ada@example.com");
    await ue.type(screen.getByLabelText("Password"), "secret");
    await ue.click(screen.getByRole("button", { name: "Sign in" }));
    await ue.type(await screen.findByLabelText("Code"), "123456");
    expect(
      await screen.findByRole("heading", { name: `Allow Stubwise on “${DEVICE}” to sign in as Ada Lovelace?` }),
    ).toBeInTheDocument();
    expect(handoffs()).toHaveLength(0);
  });

  it("la conferma non chiede il codice senza clic; «Allow» lo chiede e riapre l'app", async () => {
    signedIn = true;
    server();
    const ue = userEvent.setup();
    renderRoute(LINK);
    const allow = await screen.findByRole("button", { name: "Allow" });
    // Nessun codice al caricamento della pagina.
    await new Promise((r) => setTimeout(r, 20));
    expect(handoffs()).toHaveLength(0);
    await ue.click(allow);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`stubwise://auth?code=CODICE-MONOUSO&state=${STATE}`));
    expect(handoffs()).toHaveLength(1);
    expect(handoffs()[0]!.body).toEqual({ codeChallenge: CHALLENGE, deviceName: DEVICE });
    expect(await screen.findByText("You can close this tab.")).toBeInTheDocument();
  });

  it("riconferma richiesta: il dialogo chiede il codice, poi la conferma riparte da sola", async () => {
    signedIn = true;
    let reconfirmed = false;
    server({
      "POST /api/auth/desktop-handoff": () =>
        reconfirmed
          ? { body: { code: "DOPO" } }
          : { status: 403, body: { code: "reauth_required", message: "x" } },
      "POST /api/me/security/reauth": () => {
        reconfirmed = true;
        return { status: 204 };
      },
    });
    const ue = userEvent.setup();
    renderRoute(LINK);
    await ue.click(await screen.findByRole("button", { name: "Allow" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Confirm it's you");
    // Sei cifre: il codice si invia da solo, come nel prototipo.
    await ue.type(screen.getByLabelText("Code"), "654321");
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`stubwise://auth?code=DOPO&state=${STATE}`));
    expect(seen.find((r) => r.path === "/api/me/security/reauth")?.body).toEqual({ code: "654321" });
  });

  it("«Cancel» non chiede nessun codice", async () => {
    signedIn = true;
    server();
    const ue = userEvent.setup();
    renderRoute(LINK);
    await ue.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Nothing was shared with the app. You can close this tab.")).toBeInTheDocument();
    expect(handoffs()).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it("un link incompleto non offre la conferma", async () => {
    signedIn = true;
    server();
    renderRoute(`/desktop-login?state=${STATE}`);
    expect(await screen.findByRole("heading", { name: "This sign-in link doesn't work" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});

/** Il ponte del preload del desktop, finto: le richieste API vanno al server finto. */
function desktopBridge(instance: string | null) {
  let listener: ((change: unknown) => void) | null = null;
  const bridge = {
    platform: "darwin",
    api: {
      request: async (req: { method: string; path: string; headers?: Record<string, string>; body?: string }) => {
        const res = await fetch(req.path, { method: req.method, headers: req.headers, body: req.body });
        return { status: res.status, headers: {}, body: res.status === 204 ? "" : await res.text() };
      },
    },
    instance: {
      get: vi.fn(async () => instance),
      set: vi.fn(async (url: string) => {
        instance = url.replace(/\/+$/, "");
        return { ok: url.startsWith("https://"), url: instance };
      }),
    },
    session: {
      startBrowserLogin: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; code: string }),
      cancelBrowserLogin: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn((cb: (change: unknown) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
      logout: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => ({ instanceUrl: instance, signedIn: false })),
    },
    openWeb: vi.fn(async () => ({ ok: true })),
  };
  (window as { stubwise?: unknown }).stubwise = bridge;
  return { bridge, emit: (change: unknown) => act(() => listener?.(change)) };
}

describe("l'ingresso del desktop (tutto dal browser)", () => {
  it("nessuna pagina del desktop mostra un campo password: indirizzo, poi «Sign in with your browser»", async () => {
    server();
    const { bridge } = desktopBridge(null);
    const ue = userEvent.setup();
    const { container } = renderRouteWithContainer("/projects");
    expect(await screen.findByRole("heading", { name: "Connect to Stubwise" })).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await ue.type(screen.getByLabelText("Address"), "https://stubwise.example.com/");
    await ue.click(screen.getByRole("button", { name: "Continue" }));
    expect(bridge.instance.set).toHaveBeenCalledWith("https://stubwise.example.com/");
    const start = await screen.findByRole("button", { name: "Sign in with your browser" });
    expect(screen.getByText("stubwise.example.com")).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await ue.click(start);
    expect(bridge.session.startBrowserLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Finish signing in in your browser" })).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("attesa del desktop: «Open again» riapre il browser, «Cancel» torna all'ingresso", async () => {
    server();
    const { bridge } = desktopBridge("https://stubwise.example.com");
    const ue = userEvent.setup();
    renderRoute("/login");
    await ue.click(await screen.findByRole("button", { name: "Sign in with your browser" }));
    await ue.click(await screen.findByRole("button", { name: "Open again" }));
    expect(bridge.session.startBrowserLogin).toHaveBeenCalledTimes(2);
    await ue.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.session.cancelBrowserLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Sign in with your browser" })).toBeInTheDocument();
  });

  it("un errore dello scambio si legge come una frase, mai come un codice", async () => {
    server();
    const { emit } = desktopBridge("https://stubwise.example.com");
    const ue = userEvent.setup();
    renderRoute("/login");
    await ue.click(await screen.findByRole("button", { name: "Sign in with your browser" }));
    await screen.findByRole("heading", { name: "Finish signing in in your browser" });
    emit({ signedIn: false, error: "invalid_grant" });
    expect(await screen.findByText("Signing in didn't finish. Start again from here.")).toBeInTheDocument();
    expect(screen.queryByText(/invalid_grant/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with your browser" })).toBeInTheDocument();
  });

  it("un errore all'avvio (nessuna istanza) si legge come una frase e riporta all'indirizzo", async () => {
    server();
    const { bridge } = desktopBridge("https://stubwise.example.com");
    bridge.session.startBrowserLogin.mockResolvedValueOnce({ ok: false, code: "no_instance" });
    const ue = userEvent.setup();
    renderRoute("/login");
    await ue.click(await screen.findByRole("button", { name: "Sign in with your browser" }));
    expect(await screen.findByText("Enter the address of your Stubwise first.")).toBeInTheDocument();
    expect(screen.queryByText(/no_instance/)).toBeNull();
  });

  it("login riuscito nel browser: si entra nell'app", async () => {
    server();
    const { emit } = desktopBridge("https://stubwise.example.com");
    const ue = userEvent.setup();
    const router = renderRoute("/login");
    await ue.click(await screen.findByRole("button", { name: "Sign in with your browser" }));
    await screen.findByRole("heading", { name: "Finish signing in in your browser" });
    signedIn = true;
    emit({ signedIn: true, user });
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
  });
});

function renderRouteWithContainer(path: string) {
  const router = renderRoute(path);
  return { router, container: document.body };
}
