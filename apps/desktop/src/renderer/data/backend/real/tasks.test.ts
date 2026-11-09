import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAttachment } from "./attachments";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverTask, TICKET_ID } from "./fakeServer";
import { addLink, removeLink } from "./taskDetail";
import { followTask, getTaskByCode, listStalled, listTasks, toStallReason, updateTask } from "./tasks";

const OTHER = "55555555-5555-4555-8555-555555555555";
const ME = "11111111-1111-4111-8111-111111111111";
const ATT = "12121212-1212-4121-8121-121212121212";

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le task dal server", () => {
  it("listTasks passa i criteri come query", async () => {
    const { seen } = installFakeServer({
      "GET /api/tasks": { body: { items: [serverTask()], truncated: false } },
    });
    const tasks = await listTasks({ families: ["todo", "active"], sizes: ["XS", "none"], projectIds: [PROJECT_ID] });
    const query = new URLSearchParams(seen[0]!.path.split("?")[1]);
    expect(query.get("families")).toBe("todo,active");
    expect(query.get("sizes")).toBe("XS,none");
    expect(query.get("projectIds")).toBe(PROJECT_ID);
    // La settimana è della fetta 2; createdById null (nessun autore umano) arriva com'è.
    expect(tasks[0]).toMatchObject({ code: "AUD-12", plannedWeek: null, slipCount: 0, createdById: null });
  });

  it("una task invisibile risponde come una che non c'è: null", async () => {
    installFakeServer({ "GET /api/tasks/by-code/AUD-404": { status: 404, body: { code: "not_found", message: "x" } } });
    expect(await getTaskByCode("aud-404")).toBeNull();
  });

  it("un motivo di ferma sconosciuto non si mostra come uno noto", async () => {
    expect(toStallReason({ kind: "__unknown__" })).toBeNull();
    expect(toStallReason({ kind: "manual", reason: "Waiting on legal" })).toEqual({
      kind: "manual",
      reason: "Waiting on legal",
      note: "",
    });
    installFakeServer({
      "GET /api/tasks/stalled": {
        body: [
          { task: serverTask(), stall: { reason: { kind: "unassigned" }, since: "2026-11-01", days: 8 } },
          { task: serverTask({ id: OTHER, ticketId: OTHER, code: "AUD-13" }), stall: { reason: { kind: "unassigned", taskId: "x" }, since: "2026-11-01", days: 8 } },
        ],
      },
    });
    expect((await listStalled()).map((r) => [r.task.code, r.stall.reason.kind])).toEqual([
      ["AUD-12", "unassigned"],
      ["AUD-13", "unassigned"],
    ]);
  });

  it("updateTask non manda mai follower, ferma, allegati o collegamenti", async () => {
    const { seen } = installFakeServer({ [`PATCH /api/tasks/${TICKET_ID}`]: { body: serverTask({ title: "New" }) } });
    expect((await updateTask(TICKET_ID, { title: "New" })).title).toBe("New");
    expect(seen[0]!.body).toEqual({ title: "New" });
    await expect(updateTask(TICKET_ID, { followerIds: [] })).rejects.toThrow(/followerIds/);
  });
});

describe("collegamenti e allegati sulle rotte di oggi", () => {
  it("relates diventa relates_to e ritorno", async () => {
    const { seen } = installFakeServer({
      [`POST /api/tickets/${TICKET_ID}/links`]: { status: 201, body: {} },
      [`GET /api/tickets/${TICKET_ID}/links`]: {
        body: [{ linkId: "l-1", relation: "relates_to", otherTicketId: OTHER }],
      },
      [`DELETE /api/tickets/${TICKET_ID}/links/l-1`]: { status: 204 },
      "GET /api/tasks/by-code/AUD-12": { body: serverTask({ links: [{ kind: "relates", taskId: OTHER }] }) },
    });
    await getTaskByCode("AUD-12");
    const after = await addLink(TICKET_ID, { kind: "relates", taskId: OTHER });
    expect(seen[1]!.body).toEqual({ targetTicketId: OTHER, kind: "relates_to" });
    expect(after.links).toEqual([{ kind: "relates", taskId: OTHER }]);
    await removeLink(TICKET_ID, { kind: "relates", taskId: OTHER });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toContain(`DELETE /api/tickets/${TICKET_ID}/links/l-1`);
  });

  it("allegati spenti: l'errore lo dice", async () => {
    installFakeServer({
      [`POST /api/tickets/${TICKET_ID}/attachments`]: {
        status: 400,
        body: { code: "storage_not_configured", message: "x" },
      },
    });
    await expect(
      addAttachment(TICKET_ID, { name: "a.txt", sizeBytes: 4, file: new Blob(["ciao"]) }),
    ).rejects.toThrow("attachments_off");
  });
});

describe("rilettura dopo una scrittura dedicata", () => {
  it("Follow e allegato per chi ha solo tickets.comment: nessun errore, stato aggiornato", async () => {
    let followed = false;
    let attached = false;
    installFakeServer({
      "GET /api/tasks/by-code/AUD-12": () => ({
        body: serverTask({
          followerIds: followed ? [ME] : [],
          attachments: attached ? [{ id: ATT, name: "a.txt", sizeBytes: 4 }] : [],
        }),
      }),
      // Senza tickets.edit la PATCH è vietata: la rilettura non deve passare da lì.
      [`PATCH /api/tasks/${TICKET_ID}`]: { status: 403, body: { code: "forbidden", message: "x" } },
      [`PUT /api/tasks/${TICKET_ID}/follow`]: () => {
        followed = true;
        return { status: 204 };
      },
      [`POST /api/tickets/${TICKET_ID}/attachments`]: () => {
        attached = true;
        return { status: 201, body: {} };
      },
    });
    // Il codice della task lo conosce chi l'ha già letta (il pannello).
    await getTaskByCode("AUD-12");
    expect((await followTask(TICKET_ID, true)).followerIds).toEqual([ME]);
    const after = await addAttachment(TICKET_ID, { name: "a.txt", sizeBytes: 4, file: new Blob(["ciao"]) });
    expect(after.attachments.map((a) => a.name)).toEqual(["a.txt"]);
  });
});
