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

// Area 8, F1, `releases` nella build app: l'elenco e il dettaglio dei
// rilasci, «Fai sistemare a Claude», la Home «Rilasci». «Spiega» resta
// spento (`releases-explain`) finché la chat non ha il contesto del rilascio;
// gli ambienti restano «in arrivo».
vi.mock("@backend/api", async () => await import("./index"));
// Chi vede il progetto per le impostazioni: i fatti del server, come nella build app.
vi.mock("@backend/access", async () => await import("./accessFacts"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) =>
    name === "releases-prs" || name === "releases" || name === "releases-repo-settings";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      (t.kind === "projectSection" && t.name === "releases") ||
      (t.kind === "projectSettings" && t.name === "repositories") ||
      (t.kind === "feature" && on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
  };
});

const REPO = "33333333-3333-4333-8333-333333333333";
const TICKET = "44444444-4444-4444-8444-444444444444";
let seen: SeenRequest[] = [];

const pull = (over: Record<string, unknown> = {}) => ({
  origin: "stubwise",
  ticketId: TICKET,
  ticketNumber: 12,
  ticketTitle: "Checkout più veloce",
  repositoryId: REPO,
  repositoryName: "audin-app",
  repositoryFullName: "audin/audin-app",
  projectId: PROJECT_ID,
  projectCode: "AUD",
  branch: "stubwise/ticket-12",
  baseBranch: "main",
  prUrl: "https://github.com/audin/audin-app/pull/246",
  prNumber: 246,
  headSha: "a".repeat(40),
  createdAt: "2026-11-13T09:00:00.000Z",
  checks: { status: "success", checks: [] },
  deployedOn: [],
  onStaging: false,
  analysis: { verdict: "approve", summary: "Tutto bene", stale: false },
  corrections: { count: 0, lastStatus: null },
  correctionHistory: [],
  cap: 3,
  analysisOnly: null,
  prState: { state: "clean", autoRound: 0, canAutoCorrect: false },
  ready: true,
  fromFork: false,
  mergeable: null,
  colleaguePrs: "analyze_only",
  issues: [],
  releaseNotes: null,
  permissions: { analysisOnly: false, requestCorrection: true, editReleaseNotes: true },
  ...over,
});

function install(opts: { merge?: boolean; routes?: Record<string, unknown> } = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": {
      body: me({
        instancePermissions: ["users.view_all"],
        projectPermissions: {
          [PROJECT_ID]: ["tickets.view_all", ...(opts.merge === false ? [] : ["release.merge"])],
        },
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
    [`GET /api/projects/${PROJECT_ID}/pulls`]: { body: { items: [pull()] } },
    "GET /api/release-queue": {
      body: {
        items:
          opts.merge === false
            ? []
            : [{ repositoryId: REPO, prNumber: 246, projectId: PROJECT_ID }],
      },
    },
    [`POST /api/tickets/${TICKET}/repositories/${REPO}/release`]: {
      body: { merged: true, sha: "b".repeat(40), releaseCode: null },
    },
    ...opts.routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const failedRow = (over: Record<string, unknown> = {}) => ({
  id: "55555555-5555-4555-8555-555555555555",
  code: "AUD-V3",
  projectId: PROJECT_ID,
  repositoryId: REPO,
  repositoryName: "audin-app",
  repositoryFullName: "audin/audin-app",
  prNumber: 246,
  prUrl: "https://github.com/audin/audin-app/pull/246",
  title: "Checkout più veloce",
  mergeSha: "c".repeat(40),
  mergedAt: "2026-11-13T09:00:00.000Z",
  mergedById: ME_ID,
  mergedGitName: null,
  viaStubwise: true,
  status: { kind: "failed", since: "2026-11-13T09:05:00.000Z" },
  fixTask: null,
  permissions: { fix: true, startFix: false },
  waitsOnViewer: true,
  ...over,
});
const failedDetail = () => ({
  ...failedRow(),
  runs: [
    {
      id: "r1",
      name: "Deploy to production",
      status: "failed",
      url: "https://github.com/audin/audin-app/actions/runs/1",
      failedStep: "Run migrations",
      startedAt: "2026-11-13T09:01:00.000Z",
      endedAt: "2026-11-13T09:05:00.000Z",
    },
  ],
  releaseNotes: null,
  seenInProductionAt: null,
  relatedTaskCode: null,
  fixBlock: null,
  productionServer: null,
});

describe("i rilasci nella build app (area 8, F1, releases)", () => {
  it("l'elenco dei rilasci dal server; gli ambienti restano «Coming soon» e non si leggono", async () => {
    install({
      routes: { [`GET /api/projects/${PROJECT_ID}/releases`]: { body: { items: [failedRow()] } } },
    });
    renderRoute("/p/AUD/releases");
    const part = await screen.findByRole("region", { name: "Releases" }, { timeout: 3000 });
    await waitFor(() => expect(part.textContent).toContain("AUD-V3"));
    expect(
      within(screen.getByRole("region", { name: "Environments" })).getByText("Coming soon"),
    ).toBeTruthy();
    expect(seen.some((r) => r.path.includes("/environments"))).toBe(false);
  });

  it("il dettaglio: il passo fallito, il link alla run, «Fai sistemare a Claude» → la nota e start", async () => {
    install({
      routes: {
        "GET /api/releases/AUD-V3": { body: failedDetail() },
        "POST /api/releases/AUD-V3/fix": {
          status: 201,
          body: {
            taskId: "t1",
            taskCode: "AUD-77",
            existing: false,
            noteAdded: true,
            started: false,
          },
        },
      },
    });
    renderRoute("/p/AUD/releases/AUD-V3");
    const now = await screen.findByRole("region", { name: "Now" }, { timeout: 3000 });
    await waitFor(() => expect(now.textContent).toContain("Run migrations"));
    // «Spiega» è spento finché il server non ha il contesto del rilascio.
    expect(screen.queryByRole("button", { name: "Ask Claude to explain" })).toBeNull();
    await userEvent.click(within(now).getByRole("button", { name: "Fix it with Claude" }));
    const dialog = await screen.findByRole("dialog", { name: "Fix AUD-V3 with Claude" });
    await userEvent.type(within(dialog).getByRole("textbox"), "Guarda la 0042");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(
        seen.find((r) => r.method === "POST" && r.path === "/api/releases/AUD-V3/fix")?.body,
      ).toEqual({
        note: "Guarda la 0042",
        start: true,
      }),
    );
    expect(await screen.findByText("AUD-77 created")).toBeTruthy();
  });

  it("la Home «Rilasci» per chi può rilasciare: il fallito e la PR pronta", async () => {
    install({
      routes: {
        "GET /api/me/home": {
          body: {
            blocks: [{ kind: "releases" }],
            departmentChanged: [],
            newBlocks: [],
            departmentIds: [DEPT_ID],
            departmentHomes: [],
            personal: { blocks: [{ kind: "releases" }], seenDepartmentUpdates: {} },
          },
        },
        "GET /api/me/releases": { body: { failed: [failedRow()], ready: [pull()] } },
      },
    });
    renderRoute("/home");
    const block = await screen.findByRole("region", { name: /^Releases/ }, { timeout: 3000 });
    await waitFor(() => expect(block.textContent).toContain("AUD-V3"));
    expect(block.textContent).toContain("audin-app#246");
  });

  it("Repositories ridotta (46): l'elenco in sola lettura e nell'editor SOLO «Releases»; la modalità si salva per slug", async () => {
    install({
      routes: {
        "GET /api/auth/me": {
          body: me({
            instancePermissions: ["users.view_all"],
            projectPermissions: {
              [PROJECT_ID]: ["tickets.view_all", "release.merge", "repos.manage", "repos.view"],
            },
          }),
        },
        "GET /api/repositories": {
          body: [
            {
              id: REPO,
              projectId: PROJECT_ID,
              name: "audin-app",
              slug: "audin-app",
              provider: "github",
              repoUrl: "https://github.com/audin/audin-app",
              defaultBranch: "main",
              releaseBranch: null,
              releasePipeline: { mode: "auto" },
              ciProvider: "github_actions",
              colleaguePrs: "analyze_only",
              createdAt: "2026-11-01T09:00:00.000Z",
            },
          ],
        },
        "PATCH /api/repositories/audin-app": (req: SeenRequest) => ({
          body: {
            id: REPO,
            projectId: PROJECT_ID,
            name: "audin-app",
            slug: "audin-app",
            provider: "github",
            repoUrl: "https://github.com/audin/audin-app",
            defaultBranch: "main",
            createdAt: "2026-11-01T09:00:00.000Z",
            ...(req.body as object),
          },
        }),
      },
    });
    renderRoute("/p/AUD/settings/repositories");
    const list = await screen.findByRole(
      "list",
      { name: "Repositories of AUD" },
      { timeout: 3000 },
    );
    expect(list.textContent).toContain("audin/audin-app");
    // Nella build app niente «nuovo repository» finché non arriva l'area 9.
    expect(screen.queryByRole("button", { name: /Add repository/ })).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: /Open/ }));
    expect(await screen.findByRole("heading", { name: "Releases" })).toBeTruthy();
    // Il resto dell'editor (dettagli, account git, file d'ambiente, webhook) non c'è.
    expect(screen.queryByRole("heading", { name: "Details" })).toBeNull();
    expect(screen.queryByText(/git account/i)).toBeNull();
    expect(screen.getByRole("radio", { name: /^Analysis only/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /^Off/ }));
    await waitFor(() =>
      expect(
        seen.find((r) => r.method === "PATCH" && r.path === "/api/repositories/audin-app")?.body,
      ).toEqual({
        colleaguePrs: "off",
      }),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([
      "PATCH /api/repositories/audin-app",
    ]);
  });
});
