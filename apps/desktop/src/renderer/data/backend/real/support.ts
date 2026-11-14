import { ApiError } from "@stubwise/api-client";
import type {
  Reader,
  SupportConversation as ServerConversation,
  SupportCustomerPreview,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { CustomerPreview, SupportConversationView } from "../../support";
import type { SupportMessage } from "../../model";
import {
  CUSTOMER_STATUSES,
  SUPPORT_STATE_ORDER,
  type CustomerStatus,
  type SupportState,
} from "@stubwise/shared";
import { asPrototypeError } from "./automationRefs";
import { appClient } from "./client";

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

export function createRealSupport(api: SupportApi) {
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
  } satisfies Partial<typeof Fake.support>;
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveSupport: Partial<typeof Fake.support> = createRealSupport({
  list: (projectId, opts) => appClient().support.list(projectId, opts),
  waitingCustomers: () => appClient().support.waitingCustomers(),
  get: (code) => appClient().support.get(code),
  preview: (code) => appClient().support.preview(code),
});
