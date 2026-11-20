import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithData } from "../../../test/renderWithData";
import { ClaudeSuggestionRow } from "../../../tasks-ui/ClaudeSuggestionRow";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, PROJECT_ID, type SeenRequest } from "./fakeServer";

// La riga «Claude can help you…» nella build app (area 10, F7 di 72): la
// pagina mostra ciò che il server decide per chi guarda, senza `can()`.
// «Not now» lo salva il server per persona e per oggetto (204) e la riga si
// nasconde subito; il prototipo lo ricorda in `localStorage`, la build app no
// (un altro dispositivo, o un'altra persona sulla stessa macchina, leggono il
// server).
vi.mock("@backend/api", async () => await import("./index"));

let dismissed = false;
let seen: SeenRequest[] = [];
function install() {
  dismissed = false;
  seen = installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/claude/suggestions": () => ({
      body: dismissed
        ? null
        : {
            suggestionId: `buildAutomation:${PROJECT_ID}`,
            kind: "buildAutomation",
            page: "automations",
            objectId: PROJECT_ID,
            params: { code: "AUD" },
          },
    }),
    "POST /api/claude/suggestions/dismiss": () => {
      dismissed = true;
      return { status: 204 };
    },
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

const row = () => document.querySelector<HTMLElement>("[data-claude-suggestion]");

describe("la riga «Claude can help you…» nella build app", () => {
  it("la riga del server, con la frase del prototipo", async () => {
    install();
    renderWithData(<ClaudeSuggestionRow place={{ kind: "automations", projectId: PROJECT_ID }} />);
    await waitFor(() => expect(row()).not.toBeNull());
    expect(row()).toHaveTextContent("Claude can help you build an automation for AUD");
  });

  it("«Not now»: il tipo e l'oggetto al server, la riga se ne va, niente in localStorage", async () => {
    install();
    const ue = userEvent.setup();
    renderWithData(<ClaudeSuggestionRow place={{ kind: "automations", projectId: PROJECT_ID }} />);
    await waitFor(() => expect(row()).not.toBeNull());
    await ue.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(row()).toBeNull());
    expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { kind: "buildAutomation", objectId: PROJECT_ID },
    ]);
    expect(window.localStorage.length).toBe(0);
  });
});
