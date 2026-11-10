import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetClaudeCaches, getConversation, listConversations } from "./claude";
import { setAppClientForTests } from "./client";
import { continueConversation, setVisibility } from "./index";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// Le conversazioni pubbliche e la continuazione nella build app (chat, fetta 5,
// F5.4), sopra gli schemi della F5.1 (`claudeConversationSchema` e le rotte
// `…/visibility`, `…/continue`, `?scope=public`). Il contratto è quello del
// prototipo (`data/conversations.test.ts`, «pubbliche e continuazioni»): qui le
// viste del server diventano le sue forme.

const CONV = "cccccccc-0000-4000-8000-0000000000f5";
const MINE = "cccccccc-0000-4000-8000-0000000000f6";
const GIULIA = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "22222222-2222-4222-8222-2222222222b2";

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "free",
  title: "Callbacks",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  canWrite: false,
  canIntervene: false,
  canInterrupt: false,
  canClose: false,
  questions: [],
  inputs: [],
  ...over,
});

/** Una pubblica di Giulia vista da chi la legge (Ada, `ME_ID`). */
const theirs = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  title: "Callbacks",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  visibility: "public",
  author: { id: GIULIA, name: "Giulia Ferri" },
  isOwner: false,
  publishedAt: "2026-11-10T10:06:00.000Z",
  publishedBy: { id: GIULIA, name: "Giulia Ferri" },
  publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
  privateTail: false,
  heldProjects: [],
  continuesFrom: null,
  canPublish: false,
  canContinue: true,
  ...over,
});

/** Una conversazione di Ada (l'autrice). */
const mine = (over: Record<string, unknown> = {}) =>
  theirs({
    id: MINE,
    author: { id: ME_ID, name: "Ada" },
    isOwner: true,
    visibility: "private",
    publishedAt: null,
    publishedBy: null,
    publishedProjects: [],
    canPublish: true,
    canContinue: false,
    ...over,
  });

const noEvents = { body: { events: [], before: null } };

beforeEach(() => {
  setAppClientForTests(null);
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me({ instancePermissions: ["claude.public.view"] }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, GIULIA] })] },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" },
        { id: GIULIA, name: "Giulia Ferri", initials: "GF", departmentIds: [], email: "giulia@example.com" },
      ],
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("Public", () => {
  it("le pubbliche di altri dal server (scope=public), con l'autrice e chi l'ha resa pubblica", async () => {
    const { seen } = install({ "GET /api/claude/conversations": { body: { items: [theirs()], nextCursor: null } } });
    await getSessionPerson();
    const rows = await listConversations({ scope: "public" });
    expect(seen.some((r) => r.path.startsWith("/api/claude/conversations?scope=public"))).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        id: CONV,
        kind: "free",
        visibility: "public",
        ownerId: GIULIA,
        publishedById: GIULIA,
        publishedAt: "2026-11-10T10:06:00.000Z",
        publishedProjectIds: [PROJECT_ID],
        touchedProjectIds: [PROJECT_ID],
        privateTail: false,
      }),
    ]);
  });

  it("il seguito privato: la riga e il dettaglio lo dicono; chi legge non scrive, continua", async () => {
    install({
      "GET /api/claude/conversations": { body: { items: [theirs({ privateTail: true })], nextCursor: null } },
      [`GET /api/claude/conversations/${CONV}`]: { body: { ...theirs({ privateTail: true }), session: session(CONV) } },
      [`GET /api/agent-sessions/${CONV}`]: { body: session(CONV) },
      [`GET /api/agent-sessions/${CONV}/events`]: noEvents,
      [`GET /api/claude/conversations/${CONV}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${CONV}/groups`]: { body: [] },
    });
    await getSessionPerson();
    expect((await listConversations({ scope: "public" }))[0]).toMatchObject({ privateTail: true });
    expect(await getConversation(CONV)).toMatchObject({
      privateTail: true,
      isOwner: false,
      canWrite: false,
      canManage: false,
      canContinue: true,
      readOnlyReason: "not_owner",
      ownerId: GIULIA,
    });
  });

  it("un server più vecchio (senza i campi): tutto privato e dell'autore, come prima", async () => {
    const old = { ...theirs() } as Record<string, unknown>;
    for (const k of ["visibility", "author", "isOwner", "publishedAt", "publishedBy", "publishedProjects", "privateTail", "heldProjects", "continuesFrom", "canPublish", "canContinue"]) delete old[k];
    install({ "GET /api/claude/conversations": { body: { items: [old], nextCursor: null } } });
    await getSessionPerson();
    expect((await listConversations({ scope: "mine" }))[0]).toMatchObject({ visibility: "private", ownerId: ME_ID, privateTail: false });
  });
});

describe("Make public / Make private", () => {
  it("la prima chiamata chiede di confermare (409 needs_confirmation, anche le letture dei tool); con l'elenco, fatto", async () => {
    const { seen } = install({
      [`POST /api/claude/conversations/${MINE}/visibility`]: (req: { body?: { confirmedProjectIds?: string[] } }) =>
        req.body?.confirmedProjectIds
          ? { body: mine({ visibility: "public", publishedAt: "2026-11-10T12:00:00.000Z", publishedBy: { id: ME_ID, name: "Ada" }, publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }] }) }
          : {
              status: 409,
              body: {
                code: "needs_confirmation",
                message: "x",
                projects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
                includesToolReads: true,
                reconfirm: false,
              },
            },
    });
    await getSessionPerson();
    expect(await setVisibility(MINE, "public")).toEqual({
      status: "needs_confirmation",
      touchedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
      includesToolReads: true,
      reconfirm: false,
    });
    const done = await setVisibility(MINE, "public", { confirmedProjectIds: [PROJECT_ID] });
    expect(done).toMatchObject({ status: "done", conversation: { visibility: "public", publishedById: ME_ID, publishedProjectIds: [PROJECT_ID] } });
    expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { visibility: "public" },
      { visibility: "public", confirmedProjectIds: [PROJECT_ID] },
    ]);
  });

  it("«Make private»: nessuna conferma", async () => {
    install({ [`POST /api/claude/conversations/${MINE}/visibility`]: { body: mine() } });
    await getSessionPerson();
    expect(await setVisibility(MINE, "private")).toMatchObject({ status: "done", conversation: { visibility: "private" } });
  });

  it("non l'autore (404 come una che non esiste): not_found; un rifiuto 403: forbidden", async () => {
    install({ [`POST /api/claude/conversations/${CONV}/visibility`]: { status: 404, body: { code: "not_found", message: "x" } } });
    await getSessionPerson();
    await expect(setVisibility(CONV, "private")).rejects.toThrow("not_found");
    install({ [`POST /api/claude/conversations/${CONV}/visibility`]: { status: 403, body: { code: "forbidden", message: "x" } } });
    await expect(setVisibility(CONV, "private")).rejects.toThrow("forbidden");
  });

  it("l'autrice con un seguito privato: i progetti da riconfermare sono quelli NUOVI (heldProjects)", async () => {
    install({
      [`GET /api/claude/conversations/${MINE}`]: {
        body: {
          ...mine({
            visibility: "public",
            publishedBy: { id: ME_ID, name: "Ada" },
            publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
            heldProjects: [{ id: OTHER_PROJECT, code: "MKX", name: "Marketing" }],
          }),
          session: session(MINE, { canWrite: true, canIntervene: true }),
        },
      },
      [`GET /api/agent-sessions/${MINE}`]: { body: session(MINE) },
      [`GET /api/agent-sessions/${MINE}/events`]: noEvents,
      [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
    });
    await getSessionPerson();
    const detail = (await getConversation(MINE))!;
    expect(detail.privateFromIndex).not.toBeNull();
    expect(detail.publishedProjectIds).toEqual([PROJECT_ID]);
    expect(detail.touchedProjectIds.filter((p) => !detail.publishedProjectIds.includes(p))).toEqual([OTHER_PROJECT]);
    expect(detail).toMatchObject({ isOwner: true, canWrite: true, canManage: true, privateTail: false });
  });
});

describe("Continue", () => {
  it("continuare crea una privata mia che parte dall'originale", async () => {
    const { seen } = install({
      [`POST /api/claude/conversations/${CONV}/continue`]: { body: mine({ continuesFrom: { id: CONV, available: true } }) },
    });
    await getSessionPerson();
    expect(await continueConversation(CONV)).toMatchObject({
      id: MINE,
      kind: "free",
      ownerId: ME_ID,
      visibility: "private",
      continuesFromId: CONV,
    });
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/claude/conversations/${CONV}/continue`]);
  });

  it("una privata altrui non si continua (404 → not_found); la propria no (409 → invalid)", async () => {
    install({ [`POST /api/claude/conversations/${CONV}/continue`]: { status: 404, body: { code: "not_found", message: "x" } } });
    await getSessionPerson();
    await expect(continueConversation(CONV)).rejects.toThrow("not_found");
    install({ [`POST /api/claude/conversations/${CONV}/continue`]: { status: 409, body: { code: "own_conversation", message: "x" } } });
    await expect(continueConversation(CONV)).rejects.toThrow("invalid");
  });

  it("la continuazione legge l'originale dal vivo, come lo vede chi continua", async () => {
    install({
      [`GET /api/claude/conversations/${MINE}`]: {
        body: { ...mine({ continuesFrom: { id: CONV, available: true } }), session: session(MINE, { canWrite: true }) },
      },
      [`GET /api/agent-sessions/${MINE}`]: { body: session(MINE) },
      [`GET /api/agent-sessions/${MINE}/events`]: noEvents,
      [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
      [`GET /api/claude/conversations/${CONV}`]: { body: { ...theirs(), session: session(CONV) } },
      [`GET /api/agent-sessions/${CONV}`]: { body: session(CONV) },
      [`GET /api/agent-sessions/${CONV}/events`]: {
        body: {
          events: [{ id: "1", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:01:00.000Z", data: { text: "The callbacks are fine." } }],
          before: null,
        },
      },
      [`GET /api/claude/conversations/${CONV}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${CONV}/groups`]: { body: [] },
    });
    await getSessionPerson();
    const detail = (await getConversation(MINE))!;
    expect(detail.continuesFrom).toMatchObject({ id: CONV, available: true, title: "Callbacks", ownerId: GIULIA });
    expect(detail.continuesFrom!.events.map((e) => e.type)).toEqual(["assistant"]);
    expect(detail.canWrite).toBe(true);
  });

  it("l'originale sparito: available false, senza titolo né eventi; la continuazione resta scrivibile", async () => {
    install({
      [`GET /api/claude/conversations/${MINE}`]: {
        body: { ...mine({ continuesFrom: { id: CONV, available: false } }), session: session(MINE, { canWrite: true }) },
      },
      [`GET /api/agent-sessions/${MINE}`]: { body: session(MINE) },
      [`GET /api/agent-sessions/${MINE}/events`]: noEvents,
      [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
    });
    await getSessionPerson();
    expect(await getConversation(MINE)).toMatchObject({
      continuesFrom: { id: CONV, available: false, title: null, ownerId: null, events: [] },
      canWrite: true,
    });
  });
});

describe("l'origine di una continuazione (review F5.4)", () => {
  const ORIGIN_OF_ORIGIN = "cccccccc-0000-4000-8000-0000000000f7";
  const base = () => ({
    [`GET /api/claude/conversations/${MINE}`]: {
      body: { ...mine({ continuesFrom: { id: CONV, available: true } }), session: session(MINE, { canWrite: true }) },
    },
    [`GET /api/agent-sessions/${MINE}`]: { body: session(MINE) },
    [`GET /api/agent-sessions/${MINE}/events`]: noEvents,
    [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
    [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
  });

  it("un errore di rete sull'originale non diventa «non più disponibile»: la lettura fallisce e si riprova", async () => {
    install({
      ...base(),
      [`GET /api/claude/conversations/${CONV}`]: { status: 503, body: { code: "unavailable", message: "x" } },
      [`GET /api/agent-sessions/${CONV}`]: { status: 503, body: { code: "unavailable", message: "x" } },
    });
    await getSessionPerson();
    await expect(getConversation(MINE)).rejects.toBeTruthy();
  });

  it("un originale che non si vede più (404): «non più disponibile»", async () => {
    install({
      ...base(),
      [`GET /api/claude/conversations/${CONV}`]: { status: 404, body: { code: "not_found", message: "x" } },
      [`GET /api/agent-sessions/${CONV}`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    await getSessionPerson();
    expect((await getConversation(MINE))!.continuesFrom).toMatchObject({ id: CONV, available: false });
  });

  it("l'origine dell'origine non si legge", async () => {
    const { seen } = install({
      ...base(),
      [`GET /api/claude/conversations/${CONV}`]: {
        body: { ...theirs({ continuesFrom: { id: ORIGIN_OF_ORIGIN, available: true } }), session: session(CONV) },
      },
      [`GET /api/agent-sessions/${CONV}`]: { body: session(CONV) },
      [`GET /api/agent-sessions/${CONV}/events`]: noEvents,
      [`GET /api/claude/conversations/${CONV}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${CONV}/groups`]: { body: [] },
    });
    await getSessionPerson();
    expect((await getConversation(MINE))!.continuesFrom).toMatchObject({ id: CONV, available: true });
    expect(seen.some((r) => r.path.includes(ORIGIN_OF_ORIGIN))).toBe(false);
  });
});
