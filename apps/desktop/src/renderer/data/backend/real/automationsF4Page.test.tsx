import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_F4_AVAILABILITY } from "@stubwise/shared";
import { renderRoute } from "../../../test/renderRoute";
import { forgetAutomationRefs } from "./automationsLive";
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

// Le Automations della F4 nella build app (area 7): le generali
// (`automations.general.manage`), le sorgenti, la tabella cliente → progetto,
// «avvia un'altra». Qui `automations-f4` è acceso; nella build app resta
// spento finché il suo server non c'è.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) =>
    name === "automations" ||
    name === "automations-f2" ||
    name === "automations-f3" ||
    name === "automations-f4";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "destination" || t.kind === "projectSection" || t.kind === "feature") &&
        on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
    // Quelle che leggono `featureIntegrated` dentro il modulo: come con `automations-f4` acceso.
    generalsAvailable: () => true,
    automationAvailability: () => AUTOMATION_F4_AVAILABILITY,
  };
});

/** I permessi d'istanza di chi guarda, per test. */
const instance = { permissions: [] as string[] };

const A_ID = "77777777-7777-4777-8777-777777777771";
let seen: SeenRequest[] = [];

const FLOW = {
  trigger: { kind: "manual" },
  steps: [
    {
      id: "c1",
      kind: "claude",
      instruction: "Il contratto è firmato?",
      inputs: ["avvio.data"],
      outcomes: ["si", "no"],
      fields: [],
      branches: { si: [], no: [] },
    },
  ],
  titleTemplate: "Avvio",
};
const version = (n: number, rev: number, published: boolean) => ({
  n,
  flow: FLOW,
  publishedAt: published ? "2026-11-10T09:00:00.000Z" : null,
  publishedById: published ? ME_ID : null,
  savedAt: "2026-11-12T09:00:00.000Z",
  savedById: ME_ID,
  rev,
  testedRev: rev,
});
const row = () => ({
  id: A_ID,
  code: "AUD-A1",
  name: "Avvio progetto",
  description: "",
  projectId: PROJECT_ID,
  ownerId: ME_ID,
  status: "active",
  versions: [version(1, 3, true), version(2, 6, false)],
  createdAt: "2026-11-01T09:00:00.000Z",
  createdById: ME_ID,
  permissions: { manage: true },
  openRuns: 0,
  waitingRuns: 0,
  lastRunAt: null,
  hasDraft: true,
  configErrorCount: 0,
  liveErrorCount: 0,
});

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": {
      body: me({
        instancePermissions: ["users.view_all", ...instance.permissions],
        projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "automations.manage"] },
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
    "GET /api/me/automation-runs": { body: { items: [] } },
    "GET /api/me/automation-approvals": { body: { items: [] } },
    "GET /api/automations": { body: { items: [row()] } },
    "GET /api/automation-runs": { body: { items: [], nextCursor: null } },
    "GET /api/automations/AUD-A1": {
      body: { automation: row(), configErrors: [], liveErrors: [], runs: [] },
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetAutomationRefs();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

beforeEach(() => {
  instance.permissions = [];
});

describe("le automazioni generali (F4, R3)", () => {
  it("con automations.general.manage si crea una generale: POST con projectId null", async () => {
    instance.permissions = ["automations.general.manage"];
    install({
      "POST /api/automations": {
        body: {
          ...row(),
          id: "77777777-7777-4777-8777-77777777777a",
          code: "AUT-1",
          projectId: null,
        },
      },
    });
    renderRoute("/automations");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /New automation/ }, { timeout: 3000 }))[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Contratti");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === "/api/automations")?.body).toEqual({
        name: "Contratti",
        projectId: null,
      }),
    );
  });

  it("senza il permesso delle generali né la voce né l'opzione", async () => {
    install();
    renderRoute("/automations");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /New automation/ }, { timeout: 3000 }))[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    expect(within(dialog).queryByRole("option", { name: /Across projects/ })).toBeNull();
  });
});

describe("le sorgenti nella build app (F4, R4)", () => {
  const SOURCE_ID = "99999999-9999-4999-8999-999999999991";
  const source = {
    id: SOURCE_ID,
    kind: "webhook",
    name: "Ordini",
    status: "connected",
    connectedById: ME_ID,
    connectedAt: "2026-11-13T09:00:00.000Z",
    sampleEvents: [],
    fields: [],
    permissions: { manage: true },
    usedBy: null,
  };

  it("l'indirizzo col segreto si vede alla creazione; riaperta la sorgente, non più", async () => {
    instance.permissions = ["integrations.manage"];
    let created = false;
    install({
      "GET /api/automation-sources": () => ({ body: { items: created ? [source] : [] } }),
      "POST /api/automation-sources": () => {
        created = true;
        return { body: { source, address: "https://stubwise.test/webhooks/in/SEGRETO123" } };
      },
      "GET /api/client-links": { body: { items: [] } },
      [`GET /api/automation-sources/${SOURCE_ID}/events`]: { body: { items: [] } },
    });
    renderRoute("/automations/sources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Connect/ }, { timeout: 3000 }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Incoming webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "New incoming webhook" });
    await userEvent.type(within(dialog).getByRole("textbox"), "Ordini");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(document.querySelector("[data-webhook-address]")?.getAttribute("title")).toBe(
        "https://stubwise.test/webhooks/in/SEGRETO123",
      ),
    );
    // Chiusa e riaperta (la riga fa da interruttore): il segreto non c'è più.
    const sourceRow = () =>
      document.querySelector<HTMLElement>(`[data-source-row="${SOURCE_ID}"]`)!;
    await userEvent.click(sourceRow());
    await waitFor(() => expect(document.querySelector("[data-webhook-address]")).toBeNull());
    await userEvent.click(sourceRow());
    await waitFor(() => expect(screen.getAllByText(/address is hidden/).length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain("SEGRETO123");
  });

  it("gli eventi recenti dicono i rifiutati col motivo e i doppioni (F4-5)", async () => {
    instance.permissions = ["integrations.manage"];
    const withFields = {
      ...source,
      fields: [{ key: "importo", label: "Amount", type: "number" }],
    };
    install({
      "GET /api/automation-sources": { body: { items: [withFields] } },
      "GET /api/client-links": { body: { items: [] } },
      [`GET /api/automation-sources/${SOURCE_ID}/events`]: {
        body: {
          items: [
            {
              id: "e3",
              receivedAt: "2026-11-13T10:00:00.000Z",
              status: "rejected",
              reason: "importo: number",
              payload: { importo: "tanti" },
            },
            {
              id: "e2",
              receivedAt: "2026-11-13T09:30:00.000Z",
              status: "rejected",
              reason: "json",
              payload: null,
            },
            {
              id: "e1",
              receivedAt: "2026-11-13T09:00:00.000Z",
              status: "duplicate",
              reason: null,
              payload: { importo: 3 },
            },
          ],
        },
      },
    });
    renderRoute(`/automations/sources?source=${SOURCE_ID}`);
    const list = await screen.findByRole("list", { name: "Recent events" }, { timeout: 3000 });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toContain("Rejected: Amount — expected number");
    expect(rows[1]).toContain("Rejected: the body isn't a JSON object");
    expect(rows[2]).toContain("Duplicate: already received, nothing started");
  });
});
