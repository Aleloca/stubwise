import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { isIntegrated } from "../../integration";
import type { InboxItem } from "@stubwise/shared";
import { presentInboxItem } from "./notifications";
import { createRealPulse, type PulseApi } from "./pulse";

// Le proposte del polso nella build app (ritiro del web vecchio, inventario
// 1.4): le card `project.pulse` aperte dell'inbox, decise con
// `POST /api/inbox/:id/actions/answer` e l'indice dell'opzione.

const PRJ = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";

const card = (over: Record<string, unknown> = {}) => ({
  id: CARD,
  kind: "project.pulse",
  projectId: PRJ,
  createdAt: "2026-11-27T08:00:00.000Z",
  actions: ["answer", "open", "snooze", "handled"],
  question: { questionId: "q", text: "x", options: ["A", "B"], recommendedIndex: 1 },
  pulse: {
    projectName: "Portale autisti",
    idleDays: 9,
    proposals: [
      { backlogItemId: "33333333-3333-4333-8333-333333333333", title: "Delivery photos", urgency: "high", effort: 4 },
      { backlogItemId: "44444444-4444-4444-8444-444444444444", title: "Sign-off", urgency: null, effort: null },
    ],
  },
  ...over,
});

function fakeApi(over: Partial<PulseApi> = {}): PulseApi {
  return {
    page: vi.fn(async () => ({ items: [card()], nextCursor: null })),
    projectCodes: vi.fn(async () => new Map([[PRJ, "TRM"]])),
    answer: vi.fn(async () => ({ ticketNumber: 7, runStatus: "queued" as const })),
    handled: vi.fn(async () => undefined),
    ...over,
  };
}

describe("le proposte del polso, dal server", () => {
  it("solo le card del polso che chi guarda può decidere (l'azione `answer` del server), nella forma del prototipo", async () => {
    const api = fakeApi({
      page: vi.fn(async () => ({
        items: [card(), card({ id: "x", actions: ["open", "snooze", "handled"] }), { ...card({ id: "y" }), kind: "project.brief" }],
        nextCursor: null,
      })),
    });
    const list = await createRealPulse(api).listPulseProposals();
    expect(list).toEqual([
      {
        id: CARD,
        projectId: PRJ,
        projectCode: "TRM",
        projectName: "Portale autisti",
        idleDays: 9,
        createdAt: "2026-11-27T08:00:00.000Z",
        options: [
          { title: "Delivery photos", urgency: "high", effort: 4, suggested: false },
          { title: "Sign-off", urgency: null, effort: null, suggested: true },
        ],
      },
    ]);
  });

  it("I3: tutte le pagine delle card del pulse, non solo la prima (Decide è l'unico posto dove si decide)", async () => {
    const page = vi.fn(async (cursor: string | null) =>
      cursor === null ? { items: [card({ id: "a" })], nextCursor: "c2" } : { items: [card({ id: "b" })], nextCursor: null },
    );
    const list = await createRealPulse(fakeApi({ page })).listPulseProposals();
    expect(list.map((p) => p.id)).toEqual(["a", "b"]);
    expect(page.mock.calls.map(([c]) => c)).toEqual([null, "c2"]);
  });

  it("Start: l'indice dell'opzione; il codice della task e come è nato il run", async () => {
    const api = fakeApi();
    const real = createRealPulse(api);
    await real.listPulseProposals();
    expect(await real.startPulseProposal(CARD, 1)).toEqual({ ok: true, taskCode: "TRM-7", awaitingApproval: false });
    expect(api.answer).toHaveBeenCalledWith(CARD, 1);
    const gated = createRealPulse(
      fakeApi({ answer: vi.fn(async () => ({ ticketNumber: 8, runStatus: "awaiting_plan_approval" as const })) }),
    );
    await gated.listPulseProposals();
    expect(await gated.startPulseProposal(CARD, 0)).toMatchObject({ awaitingApproval: true, taskCode: "TRM-8" });
  });

  it("i rifiuti in parole: superata, già presa, run non partito (con la task), vietata", async () => {
    const failing = (error: ApiError) => {
      const real = createRealPulse(fakeApi({ answer: vi.fn(async () => Promise.reject(error)) }));
      return real.listPulseProposals().then(() => real.startPulseProposal(CARD, 0));
    };
    expect(await failing(new ApiError(409, "x", "proposal_stale"))).toEqual({ ok: false, reason: "stale" });
    expect(await failing(new ApiError(409, "x", "already_handled"))).toEqual({ ok: false, reason: "stale" });
    expect(
      await failing(new ApiError(409, "x", "run_not_started", { details: { code: "run_not_started", message: "x", ticketNumber: 9 } })),
    ).toEqual({ ok: false, reason: "run_not_started", taskCode: "TRM-9" });
    expect(await failing(new ApiError(403, "x", "forbidden"))).toEqual({ ok: false, reason: "forbidden" });
    expect(await failing(new ApiError(500, "x", "boom"))).toEqual({ ok: false, reason: "failed" });
    expect(await failing(new ApiError(409, "x", "budget_exhausted"))).toEqual({ ok: false, reason: "budget_exhausted" });
  });

  it("Not now: la card va fra le gestite (`handled`), soltanto per chi lo preme", async () => {
    const api = fakeApi();
    await createRealPulse(api).dismissPulseProposal(CARD);
    expect(api.handled).toHaveBeenCalledWith(CARD);
  });

  it("la funzione è integrata nella build app", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(isIntegrated({ kind: "feature", name: "pulse-proposals" })).toBe(true);
    vi.unstubAllEnvs();
  });

  it("nel pannello la card non decide: dice che c'è e apre la Home, mai il web vecchio (PQ-1b)", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const item = {
      ...card(),
      text: "TRM is idle",
      summary: null,
      readAt: null,
      status: "open",
      snoozedUntil: null,
      ticketId: null,
      jobId: null,
      url: `/backlog?projectId=${PRJ}`,
    } as unknown as InboxItem;
    const n = presentInboxItem(item, { taskCodes: new Map(), projectCodes: new Map([[PRJ, "TRM"]]) });
    expect(n.link).toBe("#/home");
    expect(n).not.toHaveProperty("webHref");
    expect(n.objectCode).toBe("TRM");
    vi.unstubAllEnvs();
  });
});
