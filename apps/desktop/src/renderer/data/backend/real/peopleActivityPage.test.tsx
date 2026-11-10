import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, TICKET_ID } from "./fakeServer";

// «By person» di Activity nella build app (integrazione area 3, fetta 3d): il
// permesso `people.activity.view` arriva dal server (registro vero), la
// rassegna dal suo aggregato. «Generate report» non c'è. «Link a person»
// (3e.2) con `users.manage`: sul web `POST /api/users/:id/git-identities` con
// la riconferma; sul desktop il gesto apre la stessa pagina sul web.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("@backend/access", async () => await import("./accessFacts"));

type Route = Parameters<typeof installFakeServer>[0][string];

function install(instancePermissions: string[], routes: Record<string, Route> = {}) {
  return installFakeServer({
    "GET /api/auth/me": {
      body: me({ instancePermissions, projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] } }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": { body: [] },
    "GET /api/activity/portfolio": { body: { events: [], nextBefore: null } },
    "GET /api/people/activity": {
      body: [
        {
          personId: ME_ID,
          name: "Ada",
          departmentIds: [DEPT_ID],
          tasksClosed: [{ taskId: TICKET_ID, code: "AUD-12", title: "Export the report", projectId: PROJECT_ID, at: "2026-10-23T09:00:00.000Z" }],
        },
        {
          personId: null,
          name: "bot@ci.example",
          authorEmail: "bot@ci.example",
          authorUsername: null,
          commits: [
            { sha: "abc1234", repo: "acme/app", authorId: null, authorName: "bot@ci.example", message: "chore: deps", aiSummary: "Bumps the dependencies", at: "2026-10-23T08:00:00.000Z", projectId: PROJECT_ID },
          ],
        },
      ],
    },
    "POST /api/activity/generate": { body: { queued: 1 } },
    "GET /api/activity": {
      // Nessun report del giorno: il prototipo offrirebbe «Generate report».
      body: { date: "2026-10-23", projects: [] },
    },
    ...routes,
  }).seen;
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

describe("«By person» nella build app", () => {
  it("col permesso dal server: la rassegna del giorno; rigenerare vale per tutti i progetti; senza users.manage niente «Link a person»", async () => {
    const seen = install(["people.activity.view", "settings.manage"]);
    renderRoute("/projects?view=person");
    expect(await screen.findByRole("radio", { name: "By person" })).toBeInTheDocument();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(await screen.findByText(/bot@ci\.example/)).toBeInTheDocument();
    await waitFor(() => expect(seen.some((r) => r.path.startsWith("/api/people/activity?date="))).toBe(true));
    // Espansa la persona, la riga del report c'è («non generato»): il gesto dice che vale per tutti i progetti.
    fireEvent.click(screen.getAllByRole("button", { name: "Expand all" })[0]!);
    expect((await screen.findAllByText("Daily report: not generated")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Generate report" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Regenerate the reports of all projects for that day" })[0]!);
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path === "/api/activity/generate")).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: "Link a person" })).toBeNull();
  });

  it("senza il permesso: la scheda non c'è e la rassegna non si legge", async () => {
    const seen = install([]);
    renderRoute("/projects");
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("radio", { name: "By person" })).toBeNull();
    expect(seen.some((r) => r.path.startsWith("/api/people/activity"))).toBe(false);
  });
});

const LINK = `POST /api/users/${ME_ID}/git-identities`;
const posts = (seen: ReturnType<typeof install>) => seen.filter((r) => r.method === "POST" && r.path.endsWith("/git-identities"));

/** «Link a person» sulla riga dell'autore non collegato, poi Ada. */
async function linkToAda() {
  const row = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-unlinked-author="bot@ci.example"]');
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.click(within(row).getByRole("button", { name: /Link a person/ }));
  const menu = await screen.findByRole("menu", { name: "Link “bot@ci.example” to" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Ada/ }));
  return row;
}

describe("«Link a person» nella build app", () => {
  const perms = ["people.activity.view", "users.manage"];

  it("la riga senza persona mostra email e username dell'autore", async () => {
    install(perms, {
      "GET /api/people/activity": {
        body: [
          {
            personId: null,
            name: "Kevin",
            authorEmail: "123+kevin@users.noreply.github.com",
            authorUsername: "kevin",
            commits: [{ sha: "abc1234", repo: "acme/app", authorId: null, authorName: "Kevin", message: "x", aiSummary: "", at: "2026-10-23T08:00:00.000Z", projectId: PROJECT_ID }],
          },
        ],
      },
    });
    renderRoute("/projects?view=person");
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-unlinked-author="Kevin"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row).toHaveTextContent("123+kevin@users.noreply.github.com");
    expect(row).toHaveTextContent("@kevin");
  });

  it("sul web collega l'email dell'autore alla persona (POST git-identities) e lo dice", async () => {
    const seen = install(perms, { [LINK]: { body: [{ id: "77777777-7777-4777-8777-777777777777", email: "bot@ci.example", authorName: "bot@ci.example" }] } });
    renderRoute("/projects?view=person");
    await linkToAda();
    expect(await screen.findByText("“bot@ci.example” is now Ada: the commits moved under them.")).toBeInTheDocument();
    expect(posts(seen).map((r) => r.body)).toEqual([{ email: "bot@ci.example", authorName: "bot@ci.example" }]);
  });

  it("la rotta vuole la riconferma: col codice giusto il collegamento riparte da solo", async () => {
    let reconfirmed = false;
    const seen = install(perms, {
      [LINK]: () =>
        reconfirmed
          ? { body: [] }
          : { status: 403, body: { code: "reauth_required", message: "x" } },
      "GET /api/me/security": {
        body: { totp: { configured: true, confirmedAt: "2026-11-01T00:00:00.000Z" }, passkeys: [], backupCodesRemaining: 8, events: [] },
      },
      "POST /api/me/security/reauth": () => {
        reconfirmed = true;
        return { status: 204 };
      },
    });
    renderRoute("/projects?view=person");
    await linkToAda();
    // Il dialogo si rimonta quando ha letto i modi di chi guarda: lo si rilegge.
    const dialog = () => screen.getByRole("dialog", { name: "Confirm it's you" });
    await waitFor(() => expect(dialog()).toHaveTextContent("link “bot@ci.example” to Ada"));
    await userEvent.setup().type(within(dialog()).getByLabelText("Code"), "654321");
    expect(await screen.findByText("“bot@ci.example” is now Ada: the commits moved under them.")).toBeInTheDocument();
    expect(posts(seen)).toHaveLength(2);
  });

  it("un'email già collegata a qualcuno (409): la sua frase", async () => {
    install(perms, { [LINK]: { status: 409, body: { code: "git_identity_taken", message: "x" } } });
    renderRoute("/projects?view=person");
    await linkToAda();
    expect(await screen.findByText("“bot@ci.example” is already linked to someone. Nothing changed.")).toBeInTheDocument();
  });

  it("una riga senza email (un server più vecchio): niente «Link a person»", async () => {
    install(perms, {
      "GET /api/people/activity": {
        body: [{ personId: null, name: "old", commits: [{ sha: "abc1234", repo: "acme/app", authorId: null, authorName: "old", message: "x", aiSummary: "", at: "2026-10-23T08:00:00.000Z", projectId: PROJECT_ID }] }],
      },
    });
    renderRoute("/projects?view=person");
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-unlinked-author="old"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(row).queryByRole("button", { name: /Link a person/ })).toBeNull();
  });

  it("sul desktop il gesto apre la stessa pagina sul web e non scrive niente", async () => {
    const openWeb = vi.fn(async () => ({ ok: true }));
    window.stubwise = { platform: "darwin", openWeb, session: { startBrowserLogin: vi.fn() } } as never;
    try {
      const seen = install(perms);
      renderRoute("/projects?view=person");
      const row = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-unlinked-author="bot@ci.example"]');
        expect(el).not.toBeNull();
        return el!;
      });
      fireEvent.click(within(row).getByRole("button", { name: /Link a person/ }));
      expect(screen.queryByRole("menu", { name: "Link “bot@ci.example” to" })).toBeNull();
      expect(openWeb).toHaveBeenCalledWith(expect.stringMatching(/^\/app\/#\/projects\?.*view=person/));
      expect(posts(seen)).toEqual([]);
    } finally {
      delete (window as { stubwise?: unknown }).stubwise;
    }
  });
});
