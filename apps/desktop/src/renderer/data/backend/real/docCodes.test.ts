import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { resolveCitations, resolveCodes } from "./claudeChat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// Area 5, fetta 1, passo 1: le pagine Docs coi loro codici stabili
// (`<PRJ>-D<n>`). Una citazione `doc` della Chat porta codice e titolo e apre la
// pagina (`#/p/<CODE>/docs/<repo>/<slug>`); un codice D scritto nel testo si
// risolve col server, e uno che chi guarda non vede non torna (R-G5).

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const MSG = "7f1c2a1e-0000-4000-8000-0000000000d1";
const CODE_ID = "7f1c2a1e-0000-4000-8000-0000000000a5";
const REPO = "7f1c2a1e-0000-4000-8000-0000000000a6";
const PAGE = "7f1c2a1e-0000-4000-8000-0000000000a7";

beforeEach(() => {
  setAppClientForTests(null);
  forgetPeopleChatCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const page = (over: Record<string, unknown> = {}) => ({
  id: PAGE,
  slug: "export",
  title: "Export guide",
  kind: "functional",
  parentId: null,
  position: 0,
  sourcePath: null,
  body: "# Export",
  isManual: false,
  commitSha: null,
  commitUrl: null,
  links: null,
  updatedAt: "2026-11-10T10:00:00.000Z",
  createdAt: "2026-11-10T10:00:00.000Z",
  viewCount: 0,
  significant: null,
  ...over,
});

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("la citazione di una pagina Docs nella Chat", () => {
  it("codice e titolo, e la pagina si apre dal suo repository e slug", async () => {
    install({
      [`GET /api/chat/messages/${MSG}`]: {
        body: {
          id: MSG,
          channelId: CH,
          threadRootId: null,
          authorId: ME_ID,
          text: "See AUD-D12",
          createdAt: "2026-11-10T10:00:00.000Z",
          citations: [
            {
              kind: "doc",
              id: CODE_ID,
              label: "Export guide",
              projectId: PROJECT_ID,
              code: "AUD-D12",
              doc: { repositoryId: REPO, repositorySlug: "audin-app", slug: "export" },
            },
          ],
        },
      },
    });
    await getSessionPerson();
    const hit = (await chat.getMessage(MSG))!;
    expect(hit.message.citations).toEqual([{ kind: "doc", id: CODE_ID }]);
    expect(await resolveCitations(hit.message.citations)).toMatchObject([
      { kind: "doc", visible: true, code: "AUD-D12", name: "Export guide", route: "#/p/AUD/docs/audin-app/export" },
    ]);
  });

  it("da un server senza codici D: il nome, senza link (come prima)", async () => {
    install({
      [`GET /api/chat/messages/${MSG}`]: {
        body: {
          id: MSG,
          channelId: CH,
          threadRootId: null,
          authorId: ME_ID,
          text: "See the guide",
          createdAt: "2026-11-10T10:00:00.000Z",
          citations: [{ kind: "doc", id: PAGE, label: "Export guide", projectId: PROJECT_ID }],
        },
      },
    });
    await getSessionPerson();
    const hit = (await chat.getMessage(MSG))!;
    expect(await resolveCitations(hit.message.citations)).toMatchObject([
      { kind: "doc", visible: true, code: null, name: "Export guide", route: null },
    ]);
  });
});

describe("un codice D scritto nel testo", () => {
  it("si risolve col server: codice, titolo della pagina e il link", async () => {
    install({
      "GET /api/docs/codes/AUD-D12": {
        body: { code: "AUD-D12", projectId: PROJECT_ID, repositoryId: REPO, repositorySlug: "audin-app", slug: "export", available: true },
      },
      [`GET /api/repositories/${REPO}/docs/pages/export`]: { body: page() },
    });
    await getSessionPerson();
    expect(await resolveCodes(["aud-d12"])).toMatchObject([
      { kind: "doc", visible: true, code: "AUD-D12", name: "Export guide", projectCode: "AUD", route: "#/p/AUD/docs/audin-app/export" },
    ]);
  });

  it("uno che non c'è o non si vede (404), e una pagina tolta (available falso): non tornano", async () => {
    const { seen } = install({
      "GET /api/docs/codes/AUD-D13": {
        body: { code: "AUD-D13", projectId: PROJECT_ID, repositoryId: REPO, repositorySlug: "audin-app", slug: "gone", available: false },
      },
    });
    await getSessionPerson();
    expect(await resolveCodes(["AUD-D12", "AUD-D13"])).toEqual([]);
    // Una pagina tolta non si va a leggere.
    expect(seen.some((r) => r.path.includes("/docs/pages/gone"))).toBe(false);
  });
});
