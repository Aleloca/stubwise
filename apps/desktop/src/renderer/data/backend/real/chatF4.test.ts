import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { resolveCitations } from "./claudeChat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// La Chat nella build app, fetta 4: gli eventi dei progetti (messaggi di
// sistema con la scheda dell'oggetto, l'impostazione «eventi pubblicati») e
// gli allegati (upload nel canale, il messaggio che li lega, il download
// firmato, la ricerca «con allegati").

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const MSG = "7f1c2a1e-0000-4000-8000-0000000000d1";
const TASK = "7f1c2a1e-0000-4000-8000-0000000000b1";
const MILESTONE = "7f1c2a1e-0000-4000-8000-0000000000b2";
const A1 = "7f1c2a1e-0000-4000-8000-0000000000e1";
const A2 = "7f1c2a1e-0000-4000-8000-0000000000e2";
const MARTA = "55555555-5555-4555-8555-555555555555";

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
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  id: MSG,
  channelId: CH,
  threadRootId: null,
  authorId: MARTA,
  kind: "person",
  text: "Here it is",
  createdAt: "2026-11-10T10:00:00.000Z",
  ...over,
});
const attachment = (id: string, filename: string, mimeType: string, sizeBytes = 2048) => ({
  id,
  filename,
  mimeType,
  sizeBytes,
  createdAt: "2026-11-10T10:00:00.000Z",
});
const system = (id: string, event: Record<string, unknown>) =>
  message({ id, kind: "system", authorId: null, text: "", event });

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

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    [`GET /api/chat/channels/${CH}`]: { body: channel() },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("gli eventi dei progetti", () => {
  const E1 = "7f1c2a1e-0000-4000-8000-0000000000f1";
  const E2 = "7f1c2a1e-0000-4000-8000-0000000000f2";
  const E3 = "7f1c2a1e-0000-4000-8000-0000000000f3";
  const E4 = "7f1c2a1e-0000-4000-8000-0000000000f4";

  it("la scheda: codice e titolo a chi vede, il solo codice a chi no, il tipo per un oggetto che non c'è più", async () => {
    install({
      [`GET /api/chat/channels/${CH}/messages`]: {
        body: {
          items: [
            system(E1, { kind: "task_closed", ref: { kind: "task", id: TASK }, object: { label: "AUD-12", title: "Export PDF", visible: true, projectId: PROJECT_ID } }),
            system(E2, { kind: "task_closed", ref: { kind: "task", id: "7f1c2a1e-0000-4000-8000-0000000000b9" }, object: { label: "AUD-13", title: null, visible: false, projectId: PROJECT_ID } }),
            system(E3, { kind: "task_closed", ref: { kind: "task", id: "7f1c2a1e-0000-4000-8000-0000000000b8" }, object: null }),
            system(E4, { kind: "milestone_reached", ref: { kind: "milestone", id: MILESTONE }, object: { label: "Beta", visible: true, projectId: PROJECT_ID } }),
          ],
          before: null,
        },
      },
    });
    await getSessionPerson();
    const page = (await chat.listMessages(CH))!;
    const [visible, hidden, gone, milestone] = page.messages;
    expect(visible).toMatchObject({ kind: "system", event: { kind: "task_closed", ref: { kind: "task", id: TASK } } });
    expect(gone!.event).toMatchObject({ kind: "task_closed", gone: true });
    expect(visible!.event).not.toHaveProperty("gone");
    const views = await resolveCitations([visible!.event!.ref, hidden!.event!.ref, milestone!.event!.ref]);
    expect(views[0]).toMatchObject({ visible: true, code: "AUD-12", name: "Export PDF", route: "#/p/AUD/tasks?task=AUD-12" });
    expect(views[1]).toMatchObject({ visible: false, code: "AUD-13", name: null, route: null });
    expect(views[2]).toMatchObject({ visible: true, code: "AUD", name: "Beta", route: "#/p/AUD" });
  });

  it("«eventi pubblicati»: l'insieme intero col PUT, il canale come lo legge chi guarda", async () => {
    const { seen } = install({
      [`PUT /api/chat/channels/${CH}/events`]: { body: channel({ publishedEvents: ["pr_merged", "task_closed"], canEditEvents: true }) },
    });
    await getSessionPerson();
    const view = await chat.setPublishedEvents(CH, ["pr_merged", "task_closed"]);
    expect(seen.find((r) => r.method === "PUT")).toMatchObject({ path: `/api/chat/channels/${CH}/events`, body: { events: ["pr_merged", "task_closed"] } });
    expect(view).toMatchObject({ id: CH, publishedEvents: ["pr_merged", "task_closed"] });
  });
});

describe("gli allegati", () => {
  it("il messaggio porta gli allegati, nel suo ordine: nome, peso, immagine o file", async () => {
    install({
      [`GET /api/chat/messages/${MSG}`]: {
        body: message({ attachments: [attachment(A1, "mock.png", "image/png"), attachment(A2, "spec.pdf", "application/pdf", 9000)] }),
      },
    });
    await getSessionPerson();
    const hit = (await chat.getMessage(MSG))!;
    expect(hit.message.attachments).toEqual([
      { id: A1, name: "mock.png", sizeBytes: 2048, kind: "image" },
      { id: A2, name: "spec.pdf", sizeBytes: 9000, kind: "file" },
    ]);
  });

  it("l'invio carica ogni file nel canale e poi lega gli allegati, in ordine; il testo può essere vuoto", async () => {
    let n = 0;
    const { seen } = install({
      [`POST /api/chat/channels/${CH}/attachments`]: () => {
        n += 1;
        return { status: 201, body: n === 1 ? attachment(A1, "mock.png", "image/png") : attachment(A2, "spec.pdf", "application/pdf") };
      },
      [`POST /api/chat/channels/${CH}/messages`]: {
        status: 201,
        body: message({ authorId: ME_ID, text: "", attachments: [attachment(A1, "mock.png", "image/png"), attachment(A2, "spec.pdf", "application/pdf")] }),
      },
    });
    await getSessionPerson();
    const sent = await chat.sendMessage(CH, {
      text: "",
      attachments: [
        { id: "draft-1", name: "mock.png", sizeBytes: 4, kind: "image", file: new Blob(["png!"], { type: "image/png" }) },
        { id: "draft-2", name: "spec.pdf", sizeBytes: 4, kind: "file", file: new Blob(["%PDF"], { type: "application/pdf" }) },
      ],
    });
    const uploads = seen.filter((r) => r.path === `/api/chat/channels/${CH}/attachments`);
    expect(uploads).toHaveLength(2);
    expect(seen.find((r) => r.path === `/api/chat/channels/${CH}/messages` && r.method === "POST")!.body).toEqual({
      text: "",
      attachmentIds: [A1, A2],
    });
    expect(sent.attachments.map((a) => a.id)).toEqual([A1, A2]);
  });

  it("un file rifiutato (tipo, peso, storage spento) ferma l'invio prima del messaggio, con un errore che la casella sa dire", async () => {
    const draft = { id: "d", name: "tool.exe", sizeBytes: 4, kind: "file" as const, file: new Blob(["MZ"]) };
    for (const [status, code, error] of [
      [400, "unsupported_type", "invalid: attachmentType"],
      [413, "file_too_large", "invalid: attachmentSize"],
      [400, "storage_not_configured", "invalid: attachmentsOff"],
    ] as const) {
      const { seen } = install({ [`POST /api/chat/channels/${CH}/attachments`]: { status, body: { code, message: "x" } } });
      await getSessionPerson();
      await expect(chat.sendMessage(CH, { text: "see", attachments: [draft] })).rejects.toThrow(error);
      expect(seen.some((r) => r.path === `/api/chat/channels/${CH}/messages`)).toBe(false);
    }
  });

  it("la ricerca «con allegati»", async () => {
    const { seen } = install({ "GET /api/chat/search": { body: { items: [] } } });
    await getSessionPerson();
    await chat.searchChat("spec", { withAttachments: true });
    expect(seen.map((r) => r.path)).toContain("/api/chat/search?q=spec&withAttachments=true");
  });

  it("il download: sul desktop lo fa il main (col solo percorso); sul web un link allo stesso percorso", async () => {
    install();
    await getSessionPerson();
    const download = vi.fn(async () => ({ ok: true as const }));
    Object.assign(window, { stubwise: { api: { request: vi.fn(), download } } });
    expect(await chat.downloadAttachment(A1)).toEqual({ ok: true });
    expect(download).toHaveBeenCalledWith(`/api/chat/attachments/${A1}/download`);
    // Il web: niente main, un link (col cookie di sessione).
    Object.assign(window, { stubwise: undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(await chat.downloadAttachment(A1)).toEqual({ ok: true });
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe(`/api/chat/attachments/${A1}/download`);
    click.mockRestore();
  });
});
