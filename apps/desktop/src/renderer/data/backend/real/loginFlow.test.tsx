import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, serverProject } from "./fakeServer";

// Il login completo nella build app web, sull'implementazione vera davanti a
// un server finto: chi non ha l'app di autenticazione la configura al login
// (decisione del maintainer del 9 nov 2026) e vede i codici di riserva PRIMA
// di entrare.
vi.mock("@backend/api", async () => await import("./index"));

const user = { id: ME_ID, email: "ada@example.com", role: "member" };
let signedIn = false;
const authed = (body: unknown) => () =>
  signedIn ? { body } : { status: 401, body: { code: "unauthenticated", message: "x" } };

beforeEach(() => {
  signedIn = false;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    "GET /api/auth/me": authed(me()),
    "POST /api/auth/login": { body: { user, stage: "enrollment" } },
    "GET /api/auth/second-factor": {
      body: { stage: "enrollment", passkeys: false, backupCodesRemaining: 0, lockedUntil: null },
    },
    "POST /api/auth/second-factor/enroll": {
      body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Stubwise:ada?secret=JBSWY3DPEHPK3PXP" },
    },
    "POST /api/auth/second-factor/enroll/confirm": () => {
      signedIn = true;
      return { body: { user, backupCodes: ["aaaa-1111", "bbbb-2222"] } };
    },
    "GET /api/projects": authed([serverProject()]),
    [`GET /api/projects/${serverProject().id}/members`]: authed([]),
    "GET /api/me/follows": authed({ projectIds: [] }),
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

describe("login nella build app web", () => {
  it("password, configurazione dell'app, codici di riserva, poi dentro", async () => {
    const ue = userEvent.setup();
    const router = renderRoute("/projects");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    // Nessun riquadro del prototipo nella build app.
    expect(screen.queryByText(/Prototype only/i)).toBeNull();

    await ue.type(await screen.findByLabelText("Email"), "ada@example.com");
    await ue.type(screen.getByLabelText("Password"), "secret");
    await ue.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Set up two-step verification" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    await ue.click(screen.getByRole("button", { name: "Next" }));
    await ue.type(screen.getByLabelText("Code"), "123456");

    // I codici si vedono prima di entrare, e «Continue» aspetta «I've saved them».
    expect(await screen.findByText("aaaa-1111")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    await ue.click(screen.getByLabelText("I've saved them"));
    await ue.click(go);

    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
  });
});
