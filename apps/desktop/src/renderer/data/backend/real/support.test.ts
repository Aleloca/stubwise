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
    reply: async (code, body) => {
      calls.push(`reply ${code} ${JSON.stringify(body)}`);
      return view({ state: "reply_sent" });
    },
    follow: async (code, on) => {
      calls.push(`follow ${code} ${on}`);
      return view({ following: on });
    },
    openRequest: async (code, body) => {
      calls.push(`request ${code} ${JSON.stringify(body)}`);
      return {
        conversation: view({ state: "request_open" }),
        request: { id: REQ, code: "ACQ-R1" },
      };
    },
    markNotConcluded: async (code) => {
      calls.push(`notConcluded ${code}`);
      return view({ state: "not_concluded", request: null });
    },
    requestDraft: async (code) => {
      calls.push(`draft ${code}`);
      return view({ claudeDraftPending: true });
    },
    emailDraft: async () => ({
      slot: "support-ACQ-S1",
      to: { name: "Lucia", email: "lucia@example.com" },
      subject: "About your request ACQ-R1",
      body: "Hi Lucia, …",
    }),
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

describe("le scritture di Support sul server (area 8, F3)", () => {
  const fail = (status: number, code: string) => async () => {
    throw new ApiError(status, code, code);
  };

  it("«Send to customer»: il testo e il clientId dell'invio (un doppio invio è uno solo), e la vista del server", async () => {
    const { api, calls } = fakeApi();
    const c = await createRealSupport(api).replyToCustomer(
      "ACQ-S1",
      "Hi Lucia",
      "66666666-6666-4666-8666-666666666666",
    );
    expect(calls).toEqual([
      `reply ACQ-S1 {"body":"Hi Lucia","clientId":"66666666-6666-4666-8666-666666666666"}`,
    ]);
    expect(c.state).toBe("reply_sent");
  });

  it("segui, apri la richiesta, «Not concluded», «Ask Claude»: le rotte, e la vista che rispondono", async () => {
    const { api, calls } = fakeApi();
    const support = createRealSupport(api);
    expect((await support.followConversation("ACQ-S1", true)).following).toBe(true);
    expect(
      (await support.openRequestFrom("ACQ-S1", { title: "Invoices", description: "x" })).state,
    ).toBe("request_open");
    expect((await support.markNotConcluded("ACQ-S1")).state).toBe("not_concluded");
    expect((await support.draftReply("ACQ-S1")).claudeDraftPending).toBe(true);
    expect(calls).toEqual([
      "follow ACQ-S1 true",
      'request ACQ-S1 {"title":"Invoices","description":"x"}',
      "notConcluded ACQ-S1",
      "draft ACQ-S1",
    ]);
  });

  it("gli errori nelle parole del prototipo", async () => {
    const words = (
      over: Partial<SupportApi>,
      run: (s: ReturnType<typeof createRealSupport>) => Promise<unknown>,
    ) => run(createRealSupport(fakeApi(over).api)).catch((e: Error) => e.message);
    expect(
      await words({ reply: fail(409, "support_triage") }, (s) => s.replyToCustomer("ACQ-S1", "x")),
    ).toBe("invalid: state");
    expect(
      await words({ reply: fail(403, "forbidden") }, (s) => s.replyToCustomer("ACQ-S1", "x")),
    ).toBe("forbidden");
    expect(
      await words({ reply: fail(404, "not_found") }, (s) => s.replyToCustomer("ACQ-S1", "x")),
    ).toBe("not_found");
    expect(
      await words({ openRequest: fail(409, "support_not_concluded") }, (s) =>
        s.openRequestFrom("ACQ-S1", { title: "x", description: "" }),
      ),
    ).toBe("invalid: state");
    expect(
      await words({ markNotConcluded: fail(409, "support_not_answered") }, (s) =>
        s.markNotConcluded("ACQ-S1"),
      ),
    ).toBe("invalid: state");
    expect(
      await words({ requestDraft: fail(409, "budget_exhausted") }, (s) => s.draftReply("ACQ-S1")),
    ).toBe("budget_exhausted");
  });

  it("«Write to them by email»: la bozza nuova per la Posta, nello slot della conversazione, da chi scrive", async () => {
    const { api } = fakeApi();
    const out = await createRealSupport(api, () => "me-1").emailDraftFor("ACQ-S1");
    expect(out.slot).toBe("support-ACQ-S1");
    expect(out.draft).toMatchObject({
      personId: "me-1",
      threadId: null,
      mode: "new",
      slot: "support-ACQ-S1",
      replyToMessageId: null,
      to: [{ name: "Lucia", email: "lucia@example.com", personId: null }],
      cc: [],
      subject: "About your request ACQ-R1",
      body: "Hi Lucia, …",
      attachments: [],
    });
  });

  it("l'email bloccata (409 support_triage, o senza email) nelle parole del prototipo", async () => {
    const { api } = fakeApi({ emailDraft: fail(409, "support_triage") });
    await expect(createRealSupport(api).emailDraftFor("ACQ-S1")).rejects.toThrow("invalid: state");
  });
});
