import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { forgetPeopleChatCaches } from "./chat";
import { resetChatStreams, setChatStreamTransport } from "./chatStream";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// La Chat nelle pagine della build app, fetta 4 (`chat-events` e
// `chat-attachments` accesi): le schede degli eventi dei progetti,
// l'impostazione «eventi pubblicati», gli allegati (scelta, limiti, upload,
// download dal main) e la ricerca «con allegati».
vi.mock("@backend/api", async () => await import("./index"));

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const MSG = "7f1c2a1e-0000-4000-8000-0000000000d1";
const A1 = "7f1c2a1e-0000-4000-8000-0000000000e1";
const TASK = "7f1c2a1e-0000-4000-8000-0000000000b1";
const MARTA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

const channel = (over: Record<string, unknown> = {}) => ({
  id: CH,
  kind: "project",
  projectId: PROJECT_ID,
  name: "design",
  visibility: "open",
  createdBy: MARTA,
  createdAt: "2026-11-10T09:00:00.000Z",
  memberIds: [ME_ID, MARTA],
  isMember: true,
  canWrite: true,
  canLeave: true,
  lastMessageAt: "2026-11-10T10:00:00.000Z",
  lastReadAt: "2026-11-10T10:00:00.000Z",
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  id: MSG,
  channelId: CH,
  threadRootId: null,
  authorId: MARTA,
  kind: "person",
  text: "The new layout is up.",
  createdAt: "2026-11-10T10:00:00.000Z",
  ...over,
});
const pdf = { id: A1, filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 2048, createdAt: "2026-11-10T10:00:00.000Z" };

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" },
        { id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [DEPT_ID], email: "marta@example.com" },
      ],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/chat/channels": { body: { items: [channel()] } },
    [`GET /api/chat/channels/${CH}`]: { body: channel() },
    [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [message()], before: null } },
    [`POST /api/chat/channels/${CH}/read`]: { status: 204 },
    "GET /api/chat/threads": { body: { items: [] } },
    "GET /api/chat/mentions": { body: { items: [] } },
    "GET /api/chat/signal": { body: { hasNews: false, mentions: 0 } },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetChatStreams();
  forgetPeopleChatCaches();
  setChatStreamTransport(() => () => undefined);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  setChatStreamTransport(null);
  Object.assign(window, { stubwise: undefined });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const fileInput = () => document.querySelector<HTMLInputElement>("[data-chat-file-input]")!;

describe("gli allegati, nella build app", () => {
  it("un PDF scelto si carica nel canale all'invio e il messaggio lo lega", async () => {
    install({
      [`POST /api/chat/channels/${CH}/attachments`]: { status: 201, body: pdf },
      [`POST /api/chat/channels/${CH}/messages`]: {
        status: 201,
        body: message({ id: "7f1c2a1e-0000-4000-8000-0000000000d9", authorId: ME_ID, text: "", attachments: [pdf] }),
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    await ue.upload(fileInput(), new File(["%PDF"], "spec.pdf", { type: "application/pdf" }));
    const box = screen.getByRole("combobox", { name: /^Message/ });
    await ue.click(box);
    await ue.keyboard("{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => r.body)).toEqual([
        { text: "", attachmentIds: [A1] },
      ]),
    );
    expect(seen.filter((r) => r.path === `/api/chat/channels/${CH}/attachments`)).toHaveLength(1);
  });

  it("un eseguibile non entra nella casella: lo dice subito, e niente si carica", async () => {
    install();
    const ue = userEvent.setup({ applyAccept: false });
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    await ue.upload(fileInput(), new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
    expect(await screen.findByText(/setup\.exe can't be attached/)).toBeInTheDocument();
    expect(document.querySelector('[data-attachment="setup.exe"]')).toBeNull();
  });

  it("un file rifiutato dal server: «Not sent» col perché", async () => {
    install({ [`POST /api/chat/channels/${CH}/attachments`]: { status: 413, body: { code: "file_too_large", message: "x" } } });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    await ue.upload(fileInput(), new File(["%PDF"], "spec.pdf", { type: "application/pdf" }));
    await ue.click(screen.getByRole("combobox", { name: /^Message/ }));
    await ue.keyboard("{Enter}");
    const failed = await screen.findByRole("alert");
    expect(within(failed).getByText("Not sent")).toBeInTheDocument();
    expect(within(failed).getByText(/too big/)).toBeInTheDocument();
  });

  it("un allegato scaduto (24 ore in sospeso): «Not sent», e «Resend» lo ricarica da sé", async () => {
    install({
      [`POST /api/chat/channels/${CH}/attachments`]: { status: 201, body: pdf },
      [`POST /api/chat/channels/${CH}/messages`]: { status: 400, body: { code: "invalid_attachments", message: "x" } },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("The new layout is up.")).toBeInTheDocument();
    await ue.upload(fileInput(), new File(["%PDF"], "spec.pdf", { type: "application/pdf" }));
    await ue.click(screen.getByRole("combobox", { name: /^Message/ }));
    await ue.keyboard("{Enter}");
    const failed = await screen.findByRole("alert");
    expect(within(failed).getByText(/expired/)).toBeInTheDocument();
    // Non chiede di allegarlo di nuovo: «Resend» lo ricarica.
    expect(within(failed).queryByText(/attach it again/)).toBeNull();
    expect(within(failed).getByText(/Resend uploads it again/)).toBeInTheDocument();
  });

  it("«Download» su un allegato: lo scarica il main, col solo percorso", async () => {
    const download = vi.fn(async () => ({ ok: true as const }));
    install({ [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [message({ attachments: [pdf] })], before: null } } });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    const chip = (await screen.findByText("spec.pdf")).closest("[data-attachment]") as HTMLElement;
    Object.assign(window, { stubwise: { ...(window.stubwise ?? {}), api: { ...(window.stubwise?.api ?? {}), download } } });
    await ue.click(within(chip).getByRole("button", { name: "Download spec.pdf" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(`/api/chat/attachments/${A1}/download`));
  });

  it("la ricerca offre «With attachments» e lo manda", async () => {
    install({ "GET /api/chat/search": { body: { items: [] } } });
    const ue = userEvent.setup();
    renderRoute("/chat?view=search&q=spec");
    const filters = await screen.findByRole("group", { name: "Search filters" }, { timeout: 3000 });
    await ue.click(within(filters).getAllByText("With attachments")[0]!);
    await waitFor(() => expect(seen.map((r) => r.path)).toContain("/api/chat/search?q=spec&withAttachments=true"));
  });
});

describe("gli eventi dei progetti, nella build app", () => {
  it("la scheda di una task chiusa (codice e titolo) e di una che non c'è più (solo il tipo)", async () => {
    const E1 = "7f1c2a1e-0000-4000-8000-0000000000f1";
    const E2 = "7f1c2a1e-0000-4000-8000-0000000000f2";
    const system = (id: string, at: string, event: Record<string, unknown>) =>
      message({ id, kind: "system", authorId: null, text: "", createdAt: at, event });
    install({
      [`GET /api/chat/channels/${CH}/messages`]: {
        body: {
          items: [
            system(E1, "2026-11-10T09:00:00.000Z", {
              kind: "task_closed",
              ref: { kind: "task", id: TASK },
              object: { label: "AUD-12", title: "Export PDF", visible: true, projectId: PROJECT_ID },
            }),
            system(E2, "2026-11-10T11:00:00.000Z", { kind: "request_new", ref: { kind: "request", id: TASK }, object: null }),
          ],
          before: null,
        },
      },
    });
    renderRoute(`/chat/${CH}`);
    expect(await screen.findByText("AUD-12", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Export PDF")).toBeInTheDocument();
    // L'oggetto sparito: nessuna riga che resta in caricamento.
    await waitFor(() => expect(document.querySelectorAll("[data-event-pending]")).toHaveLength(0));
  });

  it("«eventi pubblicati» nelle impostazioni del canale: una casella manda l'insieme intero", async () => {
    const managed = channel({ canEditEvents: true, canEditInfo: true, publishedEvents: ["task_closed"] });
    install({
      "GET /api/chat/channels": { body: { items: [managed] } },
      [`GET /api/chat/channels/${CH}`]: { body: managed },
      [`PUT /api/chat/channels/${CH}/events`]: { body: { ...managed, publishedEvents: ["pr_merged", "task_closed"] } },
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?settings=1`);
    const merged = await screen.findByRole("checkbox", { name: /PRs merged/ }, { timeout: 3000 });
    await ue.click(merged);
    await waitFor(() =>
      expect(seen.find((r) => r.method === "PUT")).toMatchObject({
        path: `/api/chat/channels/${CH}/events`,
        body: { events: expect.arrayContaining(["task_closed", "pr_merged"]) },
      }),
    );
  });
});
