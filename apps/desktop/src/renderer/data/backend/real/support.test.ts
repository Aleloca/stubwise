import { ApiError } from "@stubwise/api-client";
import type { SupportConversation } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealSupport, type SupportApi } from "./support";

// Area 8, F3: le letture di Support sulle rotte vere, con le firme del
// prototipo (`data/support/reads.ts`). Stato e azioni li calcola il server:
// il client legge, non deduce.

const PRJ = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

const message = (over: Partial<SupportConversation["messages"][number]> = {}) => ({
  id: MSG,
  from: "customer" as const,
  authorId: null,
  body: "Where is my invoice?",
  at: "2026-11-14T10:00:00.000Z",
  ...over,
});

const view = (over: Partial<SupportConversation> = {}): SupportConversation => ({
  id: CONV,
  code: "ACQ-S1",
  projectId: PRJ,
  projectCode: "ACQ",
  channel: "widget",
  widgetId: null,
  widgetName: "Portal",
  customer: { name: "Lucia", email: "lucia@example.com" },
  messages: [message()],
  lastMessage: message(),
  state: "waiting_us",
  waitingSince: "2026-11-14T10:00:00.000Z",
  rewrittenWish: null,
  confirmedAt: null,
  triage: null,
  request: {
    id: REQ,
    code: "ACQ-R1",
    title: "Invoices",
    description: "Find the invoices",
    status: "new",
    customerStatus: "received",
  },
  task: null,
  claudeDraft: null,
  claudeDraftAt: null,
  claudeDraftPending: false,
  following: false,
  canReply: true,
  replyClosed: null,
  canOpenRequest: false,
  canMarkNotConcluded: false,
  emailBlocked: null,
  createdAt: "2026-11-14T09:59:00.000Z",
  lastMessageAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

const notFound = async () => {
  throw new ApiError(404, "not_found", "not_found");
};

function fakeApi(over: Partial<SupportApi> = {}) {
  const calls: string[] = [];
  const api: SupportApi = {
    list: async (projectId, opts) => {
      calls.push(`list ${projectId} ${opts.state ?? ""}`);
      return { items: [view({ messages: [] })] };
    },
    waitingCustomers: async () => ({ items: [view({ messages: [] })] }),
    get: async () => view(),
    preview: async () => ({
      status: "received",
      messages: [
        { from: "customer", body: "Where is my invoice?", at: "2026-11-14T10:00:00.000Z" },
      ],
    }),
    ...over,
  };
  return { api, calls };
}

describe("le letture di Support dal server (area 8, F3)", () => {
  it("l'elenco nella forma del prototipo: la richiesta legata, il cliente, lo stato e l'ultimo messaggio", async () => {
    const { api, calls } = fakeApi();
    const [c] = await createRealSupport(api).listSupportConversations(PRJ, { state: "waiting_us" });
    expect(calls).toEqual([`list ${PRJ} waiting_us`]);
    expect(c).toMatchObject({
      code: "ACQ-S1",
      projectCode: "ACQ",
      state: "waiting_us",
      requestId: REQ,
      request: { code: "ACQ-R1", customerStatus: "received" },
      customer: { name: "Lucia", email: "lucia@example.com" },
      messages: [],
      lastMessage: { body: "Where is my invoice?" },
      canReply: true,
    });
  });

  it("un cliente senza nome (il widget non l'ha detto) diventa il nome vuoto: la pagina dice «Anonymous visitor»", async () => {
    const { api } = fakeApi({ get: async () => view({ customer: { name: null, email: null } }) });
    expect((await createRealSupport(api).getSupportConversation("ACQ-S1"))!.customer).toEqual({
      name: "",
      email: null,
    });
  });

  it("l'esito che è un ticket del widget, il giudizio e la bozza in arrivo passano com'erano", async () => {
    const task = {
      id: REQ,
      code: "ACQ-12",
      title: "Invoices page",
      customerStatus: "planned" as const,
    };
    const triage = {
      outcome: "concluded" as const,
      at: "2026-11-14T10:20:00.000Z",
      byUserId: null,
    };
    const { api } = fakeApi({
      get: async () => view({ request: null, task, triage, claudeDraftPending: true }),
    });
    const c = (await createRealSupport(api).getSupportConversation("ACQ-S1"))!;
    expect(c).toMatchObject({
      requestId: null,
      request: null,
      task,
      triage,
      claudeDraftPending: true,
    });
  });

  it("una conversazione nascosta o inesistente è null (R-G5), un elenco di un progetto invisibile è vuoto", async () => {
    const { api } = fakeApi({ get: notFound, preview: notFound, list: notFound });
    const support = createRealSupport(api);
    expect(await support.getSupportConversation("ACQ-S9")).toBeNull();
    expect(await support.customerPreview("ACQ-S9")).toBeNull();
    expect(await support.listSupportConversations(PRJ)).toEqual([]);
  });

  it("da un server più nuovo: uno stato sconosciuto non si mostra, un messaggio di un mittente sconosciuto nemmeno", async () => {
    const odd = {
      ...message({ id: "55555555-5555-4555-8555-555555555555" }),
      from: "__unknown__",
    } as never;
    const { api } = fakeApi({
      list: async () => ({
        items: [view({ messages: [] }), view({ code: "ACQ-S2", state: "__unknown__" as never })],
      }),
      get: async () => view({ messages: [message(), odd] }),
    });
    const support = createRealSupport(api);
    expect((await support.listSupportConversations(PRJ)).map((c) => c.code)).toEqual(["ACQ-S1"]);
    expect((await support.getSupportConversation("ACQ-S1"))!.messages.map((m) => m.id)).toEqual([
      MSG,
    ]);
  });

  it("uno stato per il cliente sconosciuto (server più nuovo) si dice «Received», il primo passo", async () => {
    const { api } = fakeApi({
      get: async () =>
        view({ request: { ...view().request!, customerStatus: "__unknown__" as never } }),
    });
    expect(
      (await createRealSupport(api).getSupportConversation("ACQ-S1"))!.request!.customerStatus,
    ).toBe("received");
  });

  it("l'anteprima del cliente e «Clienti in attesa»", async () => {
    const { api } = fakeApi();
    const support = createRealSupport(api);
    expect(await support.customerPreview("ACQ-S1")).toEqual({
      status: "received",
      messages: [
        { from: "customer", body: "Where is my invoice?", at: "2026-11-14T10:00:00.000Z" },
      ],
    });
    expect((await support.listWaitingCustomers()).map((c) => c.code)).toEqual(["ACQ-S1"]);
  });

  it("un altro errore non diventa un elenco vuoto", async () => {
    const { api } = fakeApi({
      list: async () => {
        throw new ApiError(500, "internal", "x");
      },
    });
    await expect(createRealSupport(api).listSupportConversations(PRJ)).rejects.toThrow();
  });
});
