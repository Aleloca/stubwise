import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Le Automations della F2 nella build app (area 7, F2, R3): accendere e
// pubblicare un flusso che manda email chiedono la casella da cui partono,
// fra quelle vere di chi accende (`GET /api/me/google/accounts`), e il
// server riceve il suo id. Qui `automations-f2` è acceso; nella build app
// resta spento finché il maintainer non dice di accenderlo.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) => name === "automations" || name === "automations-f2";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "destination" || t.kind === "projectSection" || t.kind === "feature") &&
        on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
  };
});

const A_ID = "77777777-7777-4777-8777-777777777771";
let seen: SeenRequest[] = [];

const FLOW = {
  trigger: { kind: "manual" },
  steps: [
    {
      id: "e1",
      kind: "sendEmail",
      to: "cliente@example.com",
      subject: "Benvenuto",
      body: "Ciao",
      attachRefs: [],
      approval: { mode: "auto" },
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

const ACCOUNT_ID = "88888888-8888-4888-8888-888888888881";
const account = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT_ID,
  email: "ada@audin.test",
  workspaceId: "88888888-8888-4888-8888-888888888880",
  workspaceName: "Audin",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  proposalsEnabled: false,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: null,
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  ...over,
});
const published = {
  ...row(),
  versions: [version(1, 3, true), version(2, 6, true)],
  hasDraft: false,
};

async function openPublish() {
  renderRoute("/automations/AUD-A1");
  await userEvent.click(
    await screen.findByRole("button", { name: "Publish v2" }, { timeout: 3000 }),
  );
  return screen.findByRole("dialog", { name: "Publish version 2 of AUD-A1?" });
}

describe("accendere e pubblicare con la casella (F2, R3)", () => {
  it("la casella si sceglie fra le mie, e il server riceve il suo id", async () => {
    install({
      "GET /api/me/google/accounts": { body: [account()] },
      "POST /api/automations/AUD-A1/publish": { body: published },
    });
    const dialog = await openPublish();
    expect(await within(dialog).findByRole("radio", { name: "ada@audin.test" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(
        seen.find((r) => r.method === "POST" && r.path === "/api/automations/AUD-A1/publish")?.body,
      ).toEqual({ expectedRev: 6, mailboxAccountId: ACCOUNT_ID }),
    );
  });

  it("senza una casella utilizzabile il dialogo lo dice e non pubblica", async () => {
    install({
      "GET /api/me/google/accounts": {
        body: [account({ disabledAt: "2026-11-10T09:00:00.000Z" })],
      },
    });
    const dialog = await openPublish();
    expect(await within(dialog).findByText(/Connect a mailbox in Mail first/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("il rifiuto del server per lo scope d'invio lo dice con parole sue", async () => {
    install({
      "GET /api/me/google/accounts": { body: [account()] },
      "POST /api/automations/AUD-A1/publish": {
        status: 409,
        body: { code: "mailbox_scope", message: "mailbox_scope", missingScopes: ["x"] },
      },
    });
    const dialog = await openPublish();
    await within(dialog).findByRole("radio", { name: "ada@audin.test" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/can't send email/)).toBeInTheDocument();
  });
});

describe("le esecuzioni con email (F2, R4)", () => {
  it("approvare un'email con «Edit»: il server riceve solo i campi cambiati in `edited`", async () => {
    const RUN_ID = "77777777-7777-4777-8777-777777777775";
    install({
      "GET /api/me/google/accounts": { body: [account()] },
      "GET /api/automations/AUD-A1/runs/5": {
        body: {
          id: RUN_ID,
          automationId: A_ID,
          n: 5,
          version: 2,
          title: "Benvenuto",
          status: "waiting_approval",
          event: {},
          vars: {},
          cursor: "0",
          round: 0,
          waitingUntil: null,
          pending: {
            approverIds: [ME_ID],
            preview: { to: "cliente@example.com", subject: "Benvenuto", body: "Ciao" },
          },
          // Il registro dice il passo in attesa (come lo scrive l'esecutore).
          log: [
            {
              at: "2026-11-13T09:00:00.000Z",
              stepId: "e1",
              path: "0",
              kind: "sendEmail",
              outcome: "waiting",
              input: { to: "cliente@example.com", subject: "Benvenuto", body: "Ciao" },
              output: {},
              reason: null,
              byId: null,
              effects: [],
            },
          ],
          startedAt: "2026-11-13T09:00:00.000Z",
          endedAt: null,
          error: null,
          projectIds: [PROJECT_ID],
          code: "AUD-A1 #5",
          automationCode: "AUD-A1",
          automationName: "Avvio progetto",
          automationProjectId: PROJECT_ID,
          flow: {
            ...FLOW,
            steps: [{ ...FLOW.steps[0], approval: { mode: "ask", who: { personId: ME_ID } } }],
          },
          deciders: [ME_ID],
          ownerId: ME_ID,
          permissions: { manage: true, approve: true, chooseProject: false },
          parent: null,
          children: [],
          pendingEffect: null,
        },
      },
      "POST /api/automations/AUD-A1/runs/5/approve": { status: 204 },
    });
    renderRoute("/automations/AUD-A1/runs/5");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }, { timeout: 3000 }));
    const subject = await screen.findByRole("textbox", { name: "Subject" });
    await userEvent.clear(subject);
    await userEvent.type(subject, "Benvenuto in Audin");
    await userEvent.click(screen.getByRole("button", { name: "Approve with changes" }));
    // Parte allo scadere dell'«Undo» (5 s).
    await waitFor(
      () =>
        expect(seen.find((r) => r.path === "/api/automations/AUD-A1/runs/5/approve")?.body).toEqual(
          {
            expectedPath: "0",
            expectedRound: 0,
            edited: { subject: "Benvenuto in Audin" },
          },
        ),
      { timeout: 9000 },
    );
  }, 15_000);
});

describe("il registro di un'esecuzione con email e attese (F2, R4, le forme del motore)", () => {
  const runBody = (over: Record<string, unknown>) => ({
    automationId: A_ID,
    version: 2,
    event: {},
    vars: {},
    waitingUntil: null,
    pending: null,
    startedAt: "2026-11-13T09:00:00.000Z",
    projectIds: [PROJECT_ID],
    automationCode: "AUD-A1",
    automationName: "Avvio progetto",
    automationProjectId: PROJECT_ID,
    flow: {
      ...FLOW,
      steps: [FLOW.steps[0], { id: "w1", kind: "wait", for: { replyTo: "e1", maxDays: 3 } }],
    },
    deciders: [],
    ownerId: "22222222-2222-4222-8222-000000000099",
    permissions: { manage: true, approve: false, chooseProject: false },
    parent: null,
    children: [],
    pendingEffect: null,
    ...over,
  });
  const line = (over: Record<string, unknown>) => ({
    at: "2026-11-13T09:00:00.000Z",
    reason: null,
    byId: null,
    effects: [],
    input: {},
    output: {},
    ...over,
  });

  it("l'email partita e la risposta che chi non è il proprietario non legge", async () => {
    install({
      "GET /api/automations/AUD-A1/runs/6": {
        body: runBody({
          id: "77777777-7777-4777-8777-777777777776",
          n: 6,
          code: "AUD-A1 #6",
          title: "Benvenuto",
          status: "done",
          cursor: null,
          endedAt: "2026-11-14T09:00:00.000Z",
          error: null,
          log: [
            line({
              stepId: "e1",
              path: "0",
              kind: "sendEmail",
              outcome: "ok",
              input: { to: "cliente@example.com", subject: "Benvenuto", body: "Ciao" },
              output: { inviata: true },
              effects: [{ kind: "email", code: "gmail-msg-1" }],
            }),
            line({
              stepId: "w1",
              path: "1",
              kind: "wait",
              outcome: "ok",
              input: { replyTo: "e1", maxDays: 3 },
              output: { "risposta.arrivata": true, "risposta.testo": "" },
              replyHidden: true,
            }),
          ],
        }),
      },
    });
    renderRoute("/automations/AUD-A1/runs/6");
    expect(
      await screen.findAllByText(/cliente@example\.com/, {}, { timeout: 3000 }),
    ).not.toHaveLength(0);
    expect(document.querySelector("[data-reply-hidden]")).not.toBeNull();
  });

  it("un'email che il mittente non ha potuto mandare: il motivo in parole", async () => {
    install({
      "GET /api/automations/AUD-A1/runs/7": {
        body: runBody({
          id: "77777777-7777-4777-8777-777777777777",
          n: 7,
          code: "AUD-A1 #7",
          title: "Benvenuto",
          status: "failed",
          cursor: "0",
          endedAt: null,
          error: "token_expired",
          log: [
            line({
              stepId: "e1",
              path: "0",
              kind: "sendEmail",
              outcome: "failed",
              input: { to: "cliente@example.com", subject: "Benvenuto", body: "Ciao" },
              why: { code: "emailFailed", params: { error: "token_expired" } },
            }),
          ],
        }),
      },
    });
    renderRoute("/automations/AUD-A1/runs/7");
    expect(
      await screen.findAllByText(/the mailbox connection expired/i, {}, { timeout: 3000 }),
    ).not.toHaveLength(0);
  });
});
