import { ApiError } from "@stubwise/api-client";
import type {
  Reader,
  SupportConversation as ServerConversation,
  SupportCustomerPreview,
  SupportEmailDraft,
  SupportOpenRequestBody,
  SupportReplyBody,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { CustomerPreview, SupportConversationView } from "../../support";
import type { MailDraft, SupportMessage } from "../../model";
import {
  CUSTOMER_STATUSES,
  SUPPORT_STATE_ORDER,
  type CustomerStatus,
  type SupportState,
} from "@stubwise/shared";
import { asPrototypeError } from "./automationRefs";
import { appClient, session } from "./client";

// Support della build app (area 8, F3) sopra le rotte vere, con le firme del
// prototipo (`data/support/reads.ts`). Lo stato, la richiesta o la task
// dell'esito, il giudizio e ciò che chi guarda PUÒ fare li calcola il server:
// il client legge, non deduce. Nascosto = inesistente (R-G5): un 404 è
// `null` (o un elenco vuoto), come nel prototipo.

type Conversation = Reader<ServerConversation>;

/** Le rotte (sul client vero: `client.support`). */
export interface SupportApi {
  list(
    projectId: string,
    opts: { state?: string },
  ): Promise<Reader<{ items: ServerConversation[] }>>;
  waitingCustomers(): Promise<Reader<{ items: ServerConversation[] }>>;
  get(code: string): Promise<Conversation>;
  preview(code: string): Promise<Reader<SupportCustomerPreview>>;
  reply(code: string, body: SupportReplyBody): Promise<Conversation>;
  follow(code: string, on: boolean): Promise<Conversation>;
  openRequest(
    code: string,
    body: SupportOpenRequestBody,
  ): Promise<Reader<{ conversation: ServerConversation; request: { id: string; code: string } }>>;
  markNotConcluded(code: string): Promise<Conversation>;
  /** «Ask Claude»: accoda la bozza (202, la vista con `claudeDraftPending`). */
  requestDraft(code: string): Promise<Conversation>;
  emailDraft(code: string): Promise<Reader<SupportEmailDraft>>;
}

/**
 * Gli errori nelle parole del prototipo: uno stato che non lo permette (la
 * conversazione è in triage, non è non conclusa, non è answered) è
 * `invalid: state`, come lì; il budget di Claude finito è `budget_exhausted`.
 */
const STATE_CODES = new Set(["support_triage", "support_not_concluded", "support_not_answered"]);
function words(error: unknown): unknown {
  if (error instanceof ApiError && error.code && STATE_CODES.has(error.code))
    return new Error("invalid: state");
  if (error instanceof ApiError && error.code === "budget_exhausted")
    return new Error("budget_exhausted");
  return asPrototypeError(error);
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw words(error);
  }
}

/** Una vista che un server più nuovo manda con uno stato sconosciuto: dopo una scrittura si rilegge. */
function writtenViewOf(c: Conversation): SupportConversationView {
  const v = viewOf(c);
  if (!v) throw new Error("invalid: state");
  return v;
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw asPrototypeError(error);
  }
}

/** Uno stato per il cliente sconosciuto (server più nuovo) si dice col primo passo, «Received»: è sempre vero. */
const customerStatusOf = (s: string): CustomerStatus =>
  (CUSTOMER_STATUSES as readonly string[]).includes(s) ? (s as CustomerStatus) : "received";

const messageOf = (m: Conversation["messages"][number]): SupportMessage | null =>
  m.from === "__unknown__"
    ? null
    : { id: m.id, from: m.from, authorId: m.authorId, body: m.body, at: m.at };

/**
 * Una conversazione nella forma del prototipo, o `null` se il suo stato è
 * sconosciuto (un server più nuovo): non si mostra ciò che l'app non sa dire.
 */
function viewOf(c: Conversation): SupportConversationView | null {
  if (!(SUPPORT_STATE_ORDER as readonly string[]).includes(c.state)) return null;
  return {
    id: c.id,
    code: c.code,
    projectId: c.projectId,
    projectCode: c.projectCode,
    channel: c.channel === "__unknown__" ? "widget" : c.channel,
    widgetId: c.widgetId,
    widgetName: c.widgetName,
    // Senza nome il widget non l'ha detto: la pagina dice «Anonymous visitor».
    customer: { name: c.customer.name ?? "", email: c.customer.email },
    messages: c.messages.flatMap((m) => messageOf(m) ?? []),
    lastMessage: c.lastMessage ? messageOf(c.lastMessage) : null,
    state: c.state as SupportState,
    waitingSince: c.waitingSince,
    rewrittenWish: c.rewrittenWish,
    confirmedAt: c.confirmedAt,
    triage: c.triage
      ? {
          outcome: c.triage.outcome === "concluded" ? "concluded" : "not_concluded",
          at: c.triage.at,
          byUserId: c.triage.byUserId,
        }
      : null,
    requestId: c.request?.id ?? null,
    request: c.request
      ? {
          id: c.request.id,
          code: c.request.code,
          title: c.request.title,
          description: c.request.description,
          status: c.request.status as NonNullable<SupportConversationView["request"]>["status"],
          customerStatus: customerStatusOf(c.request.customerStatus),
        }
      : null,
    task: c.task ? { ...c.task, customerStatus: customerStatusOf(c.task.customerStatus) } : null,
    claudeDraft: c.claudeDraft,
    claudeDraftPending: c.claudeDraftPending,
    following: c.following,
    canReply: c.canReply,
    replyClosed: c.replyClosed === "triage" ? "triage" : null,
    canOpenRequest: c.canOpenRequest,
    canMarkNotConcluded: c.canMarkNotConcluded,
    emailBlocked: c.emailBlocked === "__unknown__" ? "no_permission" : c.emailBlocked,
  };
}

const viewsOf = (items: readonly Conversation[]) => items.flatMap((c) => viewOf(c) ?? []);

export function createRealSupport(
  api: SupportApi,
  me: () => string = () => session.personId ?? "",
) {
  return {
    async listSupportConversations(
      projectId: string,
      filter: { state?: string } = {},
    ): Promise<SupportConversationView[]> {
      const out = await orNull(() =>
        api.list(projectId, { ...(filter.state ? { state: filter.state } : {}) }),
      );
      return out ? viewsOf(out.items) : [];
    },

    async getSupportConversation(code: string): Promise<SupportConversationView | null> {
      const c = await orNull(() => api.get(code));
      return c ? viewOf(c) : null;
    },

    async customerPreview(code: string): Promise<CustomerPreview | null> {
      const p = await orNull(() => api.preview(code));
      if (!p) return null;
      return {
        status: customerStatusOf(p.status),
        messages: p.messages.flatMap((m) =>
          m.from === "__unknown__" ? [] : [{ from: m.from, body: m.body, at: m.at }],
        ),
      };
    },

    async listWaitingCustomers(): Promise<SupportConversationView[]> {
      const out = await orNull(() => api.waitingCustomers());
      return out ? viewsOf(out.items) : [];
    },

    /**
     * «Send to customer», allo scadere dell'Undo del compositore. `clientId`
     * è quello dell'invio: lo stesso invio ripetuto (un doppio clic, un
     * nuovo tentativo della rete) il server lo scrive una volta sola.
     */
    async replyToCustomer(
      code: string,
      body: string,
      clientId?: string,
    ): Promise<SupportConversationView> {
      return writtenViewOf(
        await call(() => api.reply(code, { body, ...(clientId ? { clientId } : {}) })),
      );
    },

    async followConversation(code: string, on: boolean): Promise<SupportConversationView> {
      return writtenViewOf(await call(() => api.follow(code, on)));
    },

    async openRequestFrom(
      code: string,
      input: { title: string; description: string },
    ): Promise<SupportConversationView> {
      const out = await call(() => api.openRequest(code, input));
      return writtenViewOf(out.conversation);
    },

    async markNotConcluded(code: string): Promise<SupportConversationView> {
      return writtenViewOf(await call(() => api.markNotConcluded(code)));
    },

    /** «Ask Claude»: il server accoda la bozza; la vista dice `claudeDraftPending` finché non arriva. */
    async draftReply(code: string): Promise<SupportConversationView> {
      return writtenViewOf(await call(() => api.requestDraft(code)));
    },

    /**
     * «Write to them by email»: la bozza NUOVA da aprire nella Posta, nello
     * slot della conversazione, dalla casella di chi scrive. Il server non
     * salva né invia: la manda una persona, dalla Posta.
     */
    async emailDraftFor(code: string): Promise<{ slot: string; draft: MailDraft }> {
      const d = await call(() => api.emailDraft(code));
      const personId = me();
      return {
        slot: d.slot,
        draft: {
          id: `md-${personId}-${d.slot}`,
          personId,
          threadId: null,
          mode: "new",
          slot: d.slot,
          replyToMessageId: null,
          to: [{ name: d.to.name ?? "", email: d.to.email, personId: null }],
          cc: [],
          subject: d.subject,
          body: d.body,
          attachments: [],
          updatedAt: new Date().toISOString(),
        },
      };
    },
  } satisfies Partial<typeof Fake.support>;
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveSupport: Partial<typeof Fake.support> = createRealSupport({
  list: (projectId, opts) => appClient().support.list(projectId, opts),
  waitingCustomers: () => appClient().support.waitingCustomers(),
  get: (code) => appClient().support.get(code),
  preview: (code) => appClient().support.preview(code),
  reply: (code, body) => appClient().support.reply(code, body),
  follow: (code, on) => appClient().support.follow(code, on),
  openRequest: (code, body) => appClient().support.openRequest(code, body),
  markNotConcluded: (code) => appClient().support.markNotConcluded(code),
  requestDraft: (code) => appClient().support.requestDraft(code),
  emailDraft: (code) => appClient().support.emailDraft(code),
});
