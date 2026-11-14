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

// Area 8, F1, `releases-prs` nella build app: le PR aperte, la coda e il
// merge in due passi sulle rotte vere. I rilasci e gli ambienti restano «in
// arrivo» (le loro funzioni sono spente), e nessuna loro lettura parte.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) => name === "releases-prs";
  // Lo stato «solo PR»: i rilasci spenti anche se la build li accende (i cancelli per parte).
  const off = (name: string) => name === "releases";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      (t.kind === "projectSection" && t.name === "releases") ||
      (t.kind === "feature" && on(t.name)) ||
      (!(t.kind === "feature" && off(t.name)) && actual.isIntegrated(t)),
    featureIntegrated: (name: string) => on(name) || (!off(name) && actual.featureIntegrated(name)),
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

describe("le PR aperte nella build app (area 8, F1, releases-prs)", () => {
  it("l'elenco delle PR dal server; rilasci e ambienti «Coming soon», senza leggerli", async () => {
    install();
    renderRoute("/p/AUD/releases");
    const prs = await screen.findByRole("region", { name: "Pull requests" }, { timeout: 3000 });
    await waitFor(() => expect(prs.textContent).toContain("Checkout più veloce"));
    expect(
      within(screen.getByRole("region", { name: "Releases" })).getByText("Coming soon"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Environments" })).getByText("Coming soon"),
    ).toBeTruthy();
    expect(
      seen.some((r) => r.path.includes("/releases") && r.path.startsWith("/api/projects")),
    ).toBe(false);
    expect(seen.some((r) => r.path.includes("/environments"))).toBe(false);
  });

  it("il link di una card PR (`?pr=<repository>%23<n>`, F2 R4) apre il pannello di quella PR", async () => {
    install();
    renderRoute(`/p/AUD/releases?pr=${REPO}%23246`);
    expect(await screen.findByLabelText(/Pull request .*#246/, {}, { timeout: 3000 })).toBeTruthy();
  });

  it("il merge in due passi: «Release», poi «Confirm merge» → la rotta del merge della PR", async () => {
    install();
    renderRoute("/p/AUD/releases");
    await userEvent.click(
      await screen.findByRole("button", { name: "Release audin-app#246" }, { timeout: 3000 }),
    );
    expect(seen.some((r) => r.method === "POST")).toBe(false);
    await userEvent.click(await screen.findByRole("button", { name: "Confirm merge" }));
    await waitFor(() =>
      expect(
        seen.some(
          (r) =>
            r.method === "POST" && r.path === `/api/tickets/${TICKET}/repositories/${REPO}/release`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Merged.")).toBeTruthy();
  });

  it("chi non ha release.merge vede la PR ma non «Release», e nessun merge parte", async () => {
    install({ merge: false });
    renderRoute("/p/AUD/releases");
    const prs = await screen.findByRole("region", { name: "Pull requests" }, { timeout: 3000 });
    await waitFor(() => expect(prs.textContent).toContain("Checkout più veloce"));
    expect(screen.queryByRole("button", { name: "Release audin-app#246" })).toBeNull();
    expect(seen.some((r) => r.method === "POST")).toBe(false);
  });

  it("il dettaglio di un rilascio, con i rilasci spenti: «Coming soon», nessuna lettura", async () => {
    install();
    renderRoute("/p/AUD/releases/AUD-V1");
    expect(await screen.findByText("Coming soon", {}, { timeout: 3000 })).toBeTruthy();
    expect(seen.some((r) => r.path.startsWith("/api/releases"))).toBe(false);
  });

  it("canMerge su una PR qualunque della coda, non solo sulla prima (review F1, m4)", async () => {
    install({
      routes: {
        [`GET /api/projects/${PROJECT_ID}/pulls`]: {
          body: { items: [pull({ prNumber: 245, ticketTitle: "Prima" }), pull()] },
        },
        "GET /api/release-queue": {
          body: { items: [{ repositoryId: REPO, prNumber: 246, projectId: PROJECT_ID }] },
        },
      },
    });
    renderRoute("/p/AUD/releases");
    expect(
      await screen.findByRole("button", { name: "Release audin-app#246" }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/Someone who can release in AUD can merge it/)).toBeNull();
  });
});
