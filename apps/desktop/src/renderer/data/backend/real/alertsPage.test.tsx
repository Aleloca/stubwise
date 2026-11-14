import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  type SeenRequest,
} from "./fakeServer";

// Area 8, F2 (R3): Preferenze → Notifiche nella build app, sulle rotte vere
// (`/api/me/alert-subscriptions`). Le righe e i loro stati sono quelli che
// manda il server; con la funzione `alerts` spenta né la pagina né la
// campanella del progetto leggono qualcosa.
let alertsOn = true;
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("@backend/access", async () => await import("./accessFacts"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  // `alerts` la decide il test (accesa o spenta, qualunque cosa dica la build); il resto è vero.
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      t.kind === "feature" && t.name === "alerts" ? alertsOn : actual.isIntegrated(t),
    featureIntegrated: (name: string) =>
      name === "alerts" ? alertsOn : actual.featureIntegrated(name),
  };
});

const BASE = "/api/me/alert-subscriptions";
let seen: SeenRequest[] = [];

const row = (over: Record<string, unknown> = {}) => ({
  type: "release.failed",
  group: "releases",
  labelKey: "alerts.types.release_failed",
  app: true,
  phone: true,
  state: "on",
  suspendedReason: null,
  mandatory: ["merged", "task_author"],
  saved: true,
  ...over,
});

const ROWS = [
  row(),
  row({
    type: "pr.analysis_issues",
    group: "prs",
    labelKey: "alerts.types.pr_analysis_issues",
    app: false,
    phone: false,
    state: "suspended",
    suspendedReason: "repos.view",
    mandatory: ["pr_author"],
  }),
  row({
    type: "pr.corrected",
    group: "prs",
    labelKey: "alerts.types.pr_corrected",
    app: true,
    phone: true,
    state: "mandatory",
    mandatory: ["pr_author"],
  }),
];

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": {
      body: me({
        instancePermissions: ["users.view_all"],
        projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] },
      }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        {
          id: ME_ID,
          name: "Ada",
          initials: "AD",
          departmentIds: [DEPT_ID],
          email: "ada@example.com",
        },
      ],
    },
    "GET /api/departments": {
      body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }],
    },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    [`GET ${BASE}`]: {
      body: {
        items: [{ projectId: PROJECT_ID, projectCode: "AUD", projectName: "Audin", rows: ROWS }],
      },
    },
    [`PUT ${BASE}/${PROJECT_ID}/release.failed`]: { body: row({ phone: false }) },
    [`POST ${BASE}/${PROJECT_ID}/mute`]: { body: { before: ROWS } },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

/** L'inbox con la card solo fra le aperte (il client legge aperte, posticipate e gestite). */
const inboxWith = (card: object) => (r: SeenRequest) => ({
  body: { items: r.path.includes("status=open") ? [card] : [], nextCursor: null },
});

const sw = (name: string) => screen.getByRole("switch", { name });
const ready = () =>
  screen.findByRole("switch", { name: "Release failed in AUD, App" }, { timeout: 3000 });

beforeEach(() => {
  alertsOn = true;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Preferenze → Notifiche nella build app (area 8, F2, R3)", () => {
  it("le righe e gli stati dal server; il Telefono dice che arriva sul telefono, non «Prototype»", async () => {
    install();
    renderRoute("/preferences/notifications");
    await ready();
    expect(sw("Release failed in AUD, App")).toHaveAttribute("aria-checked", "true");
    expect(sw("Release failed in AUD, Phone")).toHaveAttribute("aria-checked", "true");
    const group = document.querySelector<HTMLElement>('[data-project-group="AUD"]')!;
    expect(group).toHaveTextContent("Always for you");
    expect(group).toHaveTextContent("Paused · you can no longer see AUD's repositories");
    expect(within(group).queryByRole("switch", { name: /Claude corrected your PR/ })).toBeNull();
    expect(within(group).queryByRole("switch", { name: /PR analysis found problems/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Prototype:/ })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Sent as a push notification to the Stubwise app on your phone.",
      }),
    ).toBeVisible();
  });

  it("una riga spenta con un obbligo dice che arriva lo stesso, e dove (review F2, 5)", async () => {
    install({
      [`GET ${BASE}`]: {
        body: {
          items: [
            {
              projectId: PROJECT_ID,
              projectCode: "AUD",
              projectName: "Audin",
              rows: [
                row({ app: false, phone: true, state: "off", mandatory: ["merged"] }),
                row({ type: "release.merged", labelKey: "alerts.types.release_merged", app: false, phone: false, state: "off", mandatory: ["merged"] }),
                row({ type: "pr.opened", group: "prs", labelKey: "alerts.types.pr_opened", app: false, phone: false, state: "off", mandatory: [] }),
              ],
            },
          ],
        },
      },
    });
    renderRoute("/preferences/notifications");
    await ready();
    const lineOf = (name: string) => sw(`${name} in AUD, App`).closest("[data-alert-row]")!;
    expect(lineOf("Release failed")).toHaveTextContent("When it applies to you, it still reaches you in the app and on your phone");
    expect(lineOf("Release merged")).toHaveTextContent("When it applies to you, it still reaches you in the app");
    expect(lineOf("Release merged")).not.toHaveTextContent("on your phone");
    expect(lineOf("New PR")).not.toHaveTextContent("still reaches you");
  });

  it("una riga accesa (gli interruttori lo dicono già) o sospesa (nessuna promessa) con un obbligo non aggiunge la nota", async () => {
    install();
    renderRoute("/preferences/notifications");
    await ready();
    expect(screen.queryByText(/still reaches you/)).toBeNull();
  });

  it("i valori sono quelli del server: il Telefono di una riga solo obbligatoria, la riga dei server accesa (review F2, 1 e 4)", async () => {
    install({
      [`GET ${BASE}`]: {
        body: {
          items: [
            {
              projectId: PROJECT_ID,
              projectCode: "AUD",
              projectName: "Audin",
              rows: [
                row(),
                row({ type: "pr.corrected", group: "prs", labelKey: "alerts.types.pr_corrected", state: "mandatory", app: true, phone: true, mandatory: ["pr_author"], saved: false }),
                row({ type: "job.failed", group: "tasks", labelKey: "alerts.types.job_failed", state: "mandatory", app: true, phone: false, mandatory: ["assignee"], saved: false }),
                row({ type: "server.trouble", group: "monitor", labelKey: "alerts.types.server_trouble", state: "on", app: true, phone: true, mandatory: [], saved: false }),
              ],
            },
          ],
        },
      },
    });
    renderRoute("/preferences/notifications");
    await ready();
    const rowOf = (type: string) => document.querySelector<HTMLElement>(`[data-alert-row="${type}"]`)!;
    expect(rowOf("pr.corrected")).toHaveTextContent("App and phone");
    expect(rowOf("job.failed")).toHaveTextContent("App only");
    expect(sw("Server in trouble in AUD, App")).toHaveAttribute("aria-checked", "true");
    expect(sw("Server in trouble in AUD, Phone")).toHaveAttribute("aria-checked", "true");
  });

  it("un interruttore scrive la riga con una PUT (una patch)", async () => {
    install();
    renderRoute("/preferences/notifications");
    await ready();
    await userEvent.click(sw("Release failed in AUD, Phone"));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "PUT").map((r) => [r.path, r.body])).toEqual([
        [`${BASE}/${PROJECT_ID}/release.failed`, { phone: false }],
      ]),
    );
  });

  it("«Turn everything off» chiama il mute del server; «Undo» riscrive solo le righe scrivibili", async () => {
    install();
    renderRoute("/preferences/notifications");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Alert actions for AUD" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Turn everything off in AUD" }));
    await waitFor(() =>
      expect(seen.some((r) => r.method === "POST" && r.path === `${BASE}/${PROJECT_ID}/mute`)).toBe(
        true,
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "PUT").map((r) => [r.path, r.body])).toEqual([
        [`${BASE}/${PROJECT_ID}/release.failed`, { app: true, phone: true }],
      ]),
    );
  });

  it("con `alerts` spenta: Preferenze → Notifiche è «Coming soon», senza letture", async () => {
    alertsOn = false;
    install();
    renderRoute("/preferences/notifications");
    expect(await screen.findByText("Coming soon", {}, { timeout: 3000 })).toBeTruthy();
    expect(seen.some((r) => r.path.startsWith(BASE))).toBe(false);
  });

  const columnReady = () =>
    waitFor(() => expect(document.querySelector("[data-column-code]")).not.toBeNull(), {
      timeout: 3000,
    });

  it("la campanella del progetto c'è con `alerts` accesa", async () => {
    install();
    renderRoute("/p/AUD/overview");
    await columnReady();
    expect(await screen.findByRole("button", { name: "Alerts for AUD" })).toBeTruthy();
  });

  it("con `alerts` spenta la campanella del progetto non c'è, e non legge le iscrizioni", async () => {
    alertsOn = false;
    install();
    renderRoute("/p/AUD/overview");
    await columnReady();
    expect(screen.queryByRole("button", { name: "Alerts for AUD" })).toBeNull();
    expect(seen.some((r) => r.path.startsWith(BASE))).toBe(false);
  });

  const CARD_ID = "55555555-5555-4555-8555-555555555555";
  const cardOf = (over: Record<string, unknown> = {}) => ({
    id: CARD_ID,
    kind: "release.failed",
    status: "open",
    text: "AUD-V3 failed in production",
    actions: ["open"],
    projectId: PROJECT_ID,
    ticketId: null,
    jobId: null,
    url: "/app/#/p/AUD/releases/AUD-V3",
    createdAt: "2026-11-14T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    ...over,
  });

  /** Apre il pannello e il menu «⋯» della card. */
  async function openCardMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    const item = await waitFor(() => {
      const el = panel.querySelector<HTMLElement>(`[data-notification="${CARD_ID}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(item).getByRole("button", { name: "More actions" }));
    return panel;
  }

  it("«Don't alert me» dalla card: il mute del server (S6), e «Undo» riporta al default la riga senza scelta salvata", async () => {
    install({
      "GET /api/inbox": inboxWith(cardOf()),
      [`POST /api/inbox/${CARD_ID}/mute-type`]: {
        body: {
          // Nessuna scelta salvata prima: l'«Undo» la riporta al default, non la fissa (review F2, m1).
          before: row({ saved: false }),
          row: row({ app: false, phone: false, state: "off" }),
          projectId: PROJECT_ID,
        },
      },
      [`DELETE ${BASE}/${PROJECT_ID}/release.failed`]: { body: row({ saved: false }) },
    });
    renderRoute("/preferences/notifications");
    await ready();
    const user = userEvent.setup();
    await openCardMenu(user);
    expect(screen.getByRole("menuitem", { name: "Alert settings for AUD" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Don't alert me about this in AUD" }));
    await waitFor(() =>
      expect(
        seen.some((r) => r.method === "POST" && r.path === `/api/inbox/${CARD_ID}/mute-type`),
      ).toBe(true),
    );
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        seen.filter((r) => r.method === "PUT" || r.method === "DELETE").map((r) => [r.method, r.path]),
      ).toEqual([["DELETE", `${BASE}/${PROJECT_ID}/release.failed`]]),
    );
  });

  it("una card arrivata da obbligatorio dice perché (alertMandatory) e non offre «Don't alert me»", async () => {
    install({ "GET /api/inbox": inboxWith(cardOf({ alertMandatory: "merged" })) });
    renderRoute("/preferences/notifications");
    await ready();
    const panel = await openCardMenu(userEvent.setup());
    expect(within(panel).getByText("You get this because you did the merge")).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "Alert settings for AUD" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Don't alert me about this in AUD" })).toBeNull();
  });
});
