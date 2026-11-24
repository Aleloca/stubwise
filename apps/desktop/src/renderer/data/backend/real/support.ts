import { ApiError } from "@stubwise/api-client";
import type {
  Reader,
  SupportConversation as ServerConversation,
  SupportCustomerPreview,
  SupportOpenRequestBody,
  SupportReplyBody,
  SupportSearchResult as ServerSearchResult,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import { supportHrefIn } from "../../support/visibility";
import type {
  CustomerPreview,
  SupportConversationView,
  SupportSearchResult,
} from "../../support";
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
  get(code: string): Promise<Conversation>;
  preview(code: string): Promise<Reader<SupportCustomerPreview>>;
  replyToCollaborator(code: string, body: SupportReplyBody): Promise<Conversation>;
  openRequest(
    code: string,
    body: SupportOpenRequestBody,
  ): Promise<Reader<{ conversation: ServerConversation; request: { id: string; code: string } }>>;
  markNotConcluded(code: string): Promise<Conversation>;
  /** ⌘K (rimandi, lotto 5): `GET /api/support/search?q=`. */
  search(q: string): Promise<Reader<ServerSearchResult>[]>;
}

/**
 * Gli errori nelle parole del prototipo: uno stato che non lo permette (la
 * conversazione è in triage, non è non conclusa, non è answered) è
 * `invalid: state`, come lì.
 */
const STATE_CODES = new Set(["support_triage", "support_not_concluded", "support_not_answered"]);
function words(error: unknown): unknown {
  if (error instanceof ApiError && error.code && STATE_CODES.has(error.code))
    return new Error("invalid: state");
  // Al cliente del widget il team non scrive (area 8, F3): come il prototipo.
  if (error instanceof ApiError && error.code === "support_widget_no_reply")
    return new Error("invalid: channel");
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
    rewrittenWish: c.rewrittenWish,
    confirmedAt: c.confirmedAt,
    // API per i siti (S6): un server di prima non lo manda, il default è «dichiarato».
    identityVerified: c.identityVerified,
    triage: c.triage
      ? {
          outcome: c.triage.outcome === "concluded" ? "concluded" : "not_concluded",
          at: c.triage.at,
          byUserId: c.triage.byUserId,
        }
      : null,
    requestId: c.request?.id ?? null,
    taskId: c.task?.id ?? null,
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
    continuedIn: c.continuedIn,
    continuedFrom: c.continuedFrom,
    canReplyToCollaborator: c.canReplyToCollaborator,
    canOpenRequest: c.canOpenRequest,
    canMarkNotConcluded: c.canMarkNotConcluded,
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

    /**
     * La risposta al collaboratore (canale `mcp`), allo scadere dell'Undo del
     * compositore; su una conversazione del widget il server risponde 409
     * (`invalid: channel`). `clientId`
     * è quello dell'invio: lo stesso invio ripetuto (un doppio clic, un
     * nuovo tentativo della rete) il server lo scrive una volta sola.
     */
    async replyToCollaborator(
      code: string,
      body: string,
      clientId?: string,
    ): Promise<SupportConversationView> {
      return writtenViewOf(
        await call(() =>
          api.replyToCollaborator(code, { body, ...(clientId ? { clientId } : {}) }),
        ),
      );
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

    /**
     * ⌘K: le conversazioni trovate dal server; il link lo fa il client
     * (`projectCode`). Uno stato che il client non conosce si salta, come
     * nell'elenco.
     */
    async searchSupport(q: string): Promise<SupportSearchResult[]> {
      const needle = q.trim();
      if (!needle) return [];
      return (await api.search(needle)).flatMap((r) =>
        (SUPPORT_STATE_ORDER as readonly string[]).includes(r.state)
          ? [
              {
                kind: "support" as const,
                id: r.id,
                code: r.code,
                label: r.label,
                route: supportHrefIn(r.projectCode, r.code),
                state: r.state as SupportState,
              },
            ]
          : [],
      );
    },
  } satisfies Partial<typeof Fake.support>;
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveSupport: Partial<typeof Fake.support> = createRealSupport({
  list: (projectId, opts) => appClient().support.list(projectId, opts),
  get: (code) => appClient().support.get(code),
  preview: (code) => appClient().support.preview(code),
  replyToCollaborator: (code, body) => appClient().support.replyToCollaborator(code, body),
  openRequest: (code, body) => appClient().support.openRequest(code, body),
  markNotConcluded: (code) => appClient().support.markNotConcluded(code),
  search: (q) => appClient().support.search(q),
});
