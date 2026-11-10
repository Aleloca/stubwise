import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, serverTask } from "./fakeServer";
import {
  archiveRequest,
  convertRequest,
  createRequest,
  getRequest,
  getRequestByCode,
  listRequests,
  listRequestsToConvert,
  mergeRequest,
  reopenRequest,
  restoreRequest,
  updateRequest,
} from "./requests";

// Le richieste da trasformare in task nella build app (integrazione area 2,
// fetta 3, Task J): «Da decidere» e il blocco «Richieste nuove». La sezione
// Requests è della fetta 4: una richiesta si apre nel web vecchio.

const ITEM = "33333333-3333-4333-8333-333333333333";
const view = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  code: "AUD-R4",
  projectId: PROJECT_ID,
  title: "Export to CSV",
  status: "new",
  urgency: "urgent",
  requesterIds: [ME_ID],
  requestCount: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  webHref: "/backlog/" + ITEM,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le richieste da trasformare dal server", () => {
  it("nella forma del prototipo, col link al web; «urgent» si legge «high», senza stima «medium»", async () => {
    installFakeServer({
      "GET /api/requests/to-convert": { body: [view(), view({ id: "33333333-3333-4333-8333-333333333334", urgency: null })] },
    });
    const [first, second] = await listRequestsToConvert();
    expect(first).toMatchObject({
      id: ITEM,
      code: "AUD-R4",
      projectId: PROJECT_ID,
      title: "Export to CSV",
      status: "new",
      urgency: "high",
      requesterIds: [ME_ID],
      taskIds: [],
      similarToId: null,
      mergedIntoId: null,
      webHref: "/backlog/" + ITEM,
    });
    expect(second!.urgency).toBe("medium");
  });

  it("trasformare in task: la task nasce nel progetto della richiesta, collegata", async () => {
    const { seen } = installFakeServer({
      "GET /api/requests/to-convert": { body: [view()] },
      "POST /api/tasks": { body: serverTask({ requestId: ITEM }) },
    });
    await listRequestsToConvert();
    const task = await convertRequest(ITEM, { title: "Export to CSV", type: "feature", size: "S" });
    const post = seen.find((r) => r.method === "POST")!;
    expect(post.body).toMatchObject({ projectId: PROJECT_ID, requestId: ITEM, title: "Export to CSV", type: "feature", size: "S" });
    expect(task.code).toBe("AUD-12");
    // Il progetto viene dalla richiesta già letta: nessuna lettura in più.
    expect(seen.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      "GET /api/requests/to-convert",
      "POST /api/tasks",
    ]);
  });
});

const TARGET = "33333333-3333-4333-8333-333333333399";
const full = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  code: "AUD-R4",
  projectId: PROJECT_ID,
  title: "Export to CSV",
  description: "Users want CSV.",
  requesterIds: [ME_ID],
  status: "new",
  urgency: "high",
  urgent: true,
  size: "S",
  risk: null,
  riskNote: null,
  design: null,
  plan: null,
  similarToId: null,
  mergedIntoId: null,
  mergedIntoCode: null,
  taskIds: [],
  createdAt: "2026-11-01T09:00:00.000Z",
  suggestions: { size: "M", reason: "Bigger than it looks" },
  webHref: "/backlog/" + ITEM,
  ...over,
});

describe("le Requests dal server", () => {
  it("elenco, dettaglio per id e per codice nella forma del prototipo; «urgent» resta segnato; una voce invisibile è null", async () => {
    installFakeServer({
      "GET /api/requests": { body: [full()] },
      [`GET /api/requests/${ITEM}`]: { body: full() },
      "GET /api/requests/by-code/AUD-R4": { body: full() },
      "GET /api/requests/by-code/AUD-R404": { status: 404, body: { code: "not_found", message: "x" } },
    });
    const [request] = await listRequests(PROJECT_ID);
    expect(request).toMatchObject({
      id: ITEM,
      code: "AUD-R4",
      description: "Users want CSV.",
      urgency: "high",
      urgent: true,
      size: "S",
      risk: null,
      suggestions: { size: "M", reason: "Bigger than it looks" },
      taskIds: [],
    });
    expect((await getRequest(ITEM))?.code).toBe("AUD-R4");
    expect((await getRequestByCode("aud-r4"))?.id).toBe(ITEM);
    expect(await getRequestByCode("AUD-R404")).toBeNull();
  });

  it("Nuova richiesta: si aspetta l'intake; nuova, oppure fusa in un'altra («Unita a R12»)", async () => {
    let polls = 0;
    const { seen } = installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-1" } },
      "GET /api/requests/jobs/job-1": () => {
        polls++;
        return polls < 2
          ? { body: { status: "running", outcome: null, request: null } }
          : { body: { status: "done", outcome: "merged", request: full({ id: TARGET, code: "AUD-R12" }) } };
      },
    });
    const landed = await createRequest({ projectId: PROJECT_ID, title: "CSV please", description: "" });
    expect(seen[0]!.body).toEqual({ projectId: PROJECT_ID, title: "CSV please", description: "" });
    expect(landed).toMatchObject({ id: TARGET, code: "AUD-R12", landedByMerge: true });
    expect(polls).toBe(2);
  });

  it("un intake fallito è un errore; una richiesta nuova non è «fusa»", async () => {
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-2" } },
      "GET /api/requests/jobs/job-2": { body: { status: "failed", outcome: null, request: null } },
    });
    await expect(createRequest({ projectId: PROJECT_ID, title: "x" })).rejects.toThrow();
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-3" } },
      "GET /api/requests/jobs/job-3": { body: { status: "done", outcome: "created", request: full() } },
    });
    expect(await createRequest({ projectId: PROJECT_ID, title: "x" })).not.toHaveProperty("landedByMerge");
  });

  it("accodata ma senza esito entro il tetto: «la stiamo registrando», mai un secondo POST", async () => {
    vi.useFakeTimers();
    try {
      const { seen } = installFakeServer({
        "POST /api/requests": { status: 202, body: { jobId: "job-4" } },
        "GET /api/requests/jobs/job-4": { body: { status: "running", outcome: null, request: null } },
      });
      const out = createRequest({ projectId: PROJECT_ID, title: "x" });
      const caught = out.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await caught).toMatchObject({ message: "intake_pending" });
      expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finita senza richiesta: accodata, non «non è partito nulla»", async () => {
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-5" } },
      "GET /api/requests/jobs/job-5": { body: { status: "done", outcome: null, request: null } },
    });
    await expect(createRequest({ projectId: PROJECT_ID, title: "x" })).rejects.toThrow("intake_pending");
  });

  it("il POST che fallisce: non è partito nulla", async () => {
    installFakeServer({ "POST /api/requests": { status: 500, body: { code: "internal", message: "x" } } });
    await expect(createRequest({ projectId: PROJECT_ID, title: "x" })).rejects.not.toThrow("intake_pending");
  });

  it("qualche errore di rete durante l'attesa si tollera; troppi di fila: «la stiamo registrando»", async () => {
    let polls = 0;
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-6" } },
      "GET /api/requests/jobs/job-6": () => {
        polls++;
        if (polls <= 2) throw new TypeError("Failed to fetch");
        if (polls === 3) return { status: 503, body: { code: "unavailable", message: "x" } };
        return { body: { status: "done", outcome: "created", request: full() } };
      },
    });
    expect(await createRequest({ projectId: PROJECT_ID, title: "x" })).toMatchObject({ id: ITEM });
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-7" } },
      "GET /api/requests/jobs/job-7": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(createRequest({ projectId: PROJECT_ID, title: "x" })).rejects.toThrow("intake_pending");
  });

  it("l'attesa si ferma quando il dialogo si chiude o la sessione cambia", async () => {
    let polls = 0;
    installFakeServer({
      "POST /api/requests": { status: 202, body: { jobId: "job-8" } },
      "GET /api/requests/jobs/job-8": () => {
        polls++;
        return { body: { status: "running", outcome: null, request: null } };
      },
    });
    const controller = new AbortController();
    const out = createRequest({ projectId: PROJECT_ID, title: "x" }, { signal: controller.signal });
    await vi.waitFor(() => expect(polls).toBe(1));
    controller.abort();
    await expect(out).rejects.toThrow("aborted");
    expect(polls).toBe(1);

    polls = 0;
    session.personId = ME_ID;
    const other = createRequest({ projectId: PROJECT_ID, title: "x" });
    await vi.waitFor(() => expect(polls).toBe(1));
    session.personId = "55555555-5555-4555-8555-555555555555";
    await expect(other).rejects.toThrow("aborted");
    expect(polls).toBe(1);
  });

  it("metadati e descrizione col PATCH; scartare i suggerimenti passa dalla sua rotta", async () => {
    const { seen } = installFakeServer({
      [`PATCH /api/requests/${ITEM}`]: { body: full({ size: "M", description: "Now with Excel too." }) },
      [`POST /api/requests/${ITEM}/suggestions/dismiss`]: { body: full({ suggestions: null }) },
    });
    await updateRequest(ITEM, { description: "Now with Excel too.", urgency: "low" });
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      body: { description: "Now with Excel too.", urgency: "low" },
    });
    const dismissed = await updateRequest(ITEM, { suggestions: null });
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `/api/requests/${ITEM}/suggestions/dismiss` });
    expect(dismissed.suggestions ?? null).toBeNull();
  });

  it("accettare i suggerimenti (gli stessi valori, e via i suggerimenti) passa dalla sua rotta", async () => {
    const { seen } = installFakeServer({
      [`GET /api/requests/${ITEM}`]: { body: full() },
      [`POST /api/requests/${ITEM}/suggestions/accept`]: { body: full({ size: "M", suggestions: null }) },
    });
    await getRequest(ITEM);
    const accepted = await updateRequest(ITEM, { size: "M", suggestions: null });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/requests/${ITEM}`,
      `POST /api/requests/${ITEM}/suggestions/accept`,
    ]);
    expect(accepted.size).toBe("M");
  });

  it("archivia, riapri, ripristina; fondi (la destinazione, riscritta); una fusione fallita è un errore", async () => {
    const { seen } = installFakeServer({
      [`POST /api/requests/${ITEM}/archive`]: { body: full({ status: "archived" }) },
      [`POST /api/requests/${ITEM}/reopen`]: { body: full({ status: "new" }) },
      [`POST /api/requests/${ITEM}/restore`]: { body: full({ status: "ready" }) },
      [`POST /api/requests/${ITEM}/merge`]: (req) =>
        (req.body as { intoId: string }).intoId === TARGET
          ? { body: full({ id: TARGET, code: "AUD-R12", title: "Export (rewritten)" }) }
          : { status: 502, body: { code: "merge_failed", message: "x" } },
    });
    expect((await archiveRequest(ITEM)).status).toBe("archived");
    expect((await reopenRequest(ITEM)).status).toBe("new");
    expect((await restoreRequest(ITEM, "ready")).status).toBe("ready");
    expect(seen[2]!.body).toEqual({ status: "ready" });
    expect(await mergeRequest(ITEM, TARGET)).toMatchObject({ id: TARGET, title: "Export (rewritten)" });
    await expect(mergeRequest(ITEM, "33333333-3333-4333-8333-333333333398")).rejects.toMatchObject({
      code: "merge_failed",
    });
  });
});
