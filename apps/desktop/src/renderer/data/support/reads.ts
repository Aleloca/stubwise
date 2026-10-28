import type { CustomerStatus } from "../../domain/releases/customerStatus";
import { supportState, waitingSince, type SupportState } from "../../domain/support/state";
import { fold } from "../../domain/textSearch";
import { gate, state } from "../store";
import type { SupportConversation, SupportWidget } from "../types";
import {
  conversationView,
  customerStatusOf,
  holds,
  requestOf,
  sees,
  supportHref,
  type SupportConversationView,
} from "./visibility";

// Le letture di Support. Le liste di un progetto che chi guarda non vede
// sono vuote, il dettaglio e l'anteprima di una conversazione invisibile
// sono `null`, come una che non esiste (R-G5). Gli stati si derivano a
// lettura.

/** L'ordine dei gruppi dell'elenco (shape support.md [A 2]): chi aspetta noi in cima. */
const STATE_ORDER: readonly SupportState[] = [
  "waiting_us",
  "triage",
  "not_concluded",
  "request_open",
  "reply_sent",
];

const lastAt = (c: SupportConversation): string => c.messages.at(-1)?.at ?? "";

/** Dentro un gruppo: la più vecchia attesa in alto per «aspetta noi», la più recente per gli altri. */
function byGroup(a: SupportConversation, b: SupportConversation): number {
  const sa = supportState(a);
  const sb = supportState(b);
  if (sa !== sb) return STATE_ORDER.indexOf(sa) - STATE_ORDER.indexOf(sb);
  if (sa === "waiting_us") return waitingSince(a)!.localeCompare(waitingSince(b)!);
  return lastAt(b).localeCompare(lastAt(a)) || a.code.localeCompare(b.code);
}

/** Le conversazioni coi clienti del progetto, raggruppate per stato. */
export async function listSupportConversations(
  projectId: string,
  filter: { state?: SupportState } = {},
): Promise<SupportConversationView[]> {
  const me = await gate("support.listSupportConversations");
  if (!sees(me, projectId)) return [];
  return state.supportConversations
    .filter((c) => c.projectId === projectId)
    .filter((c) => !filter.state || supportState(c) === filter.state)
    .sort(byGroup)
    .map((c) => conversationView(me, c));
}

/** Il dettaglio di una conversazione (`ACQ-S2`); `null` se nascosta o inesistente. */
export async function getSupportConversation(
  code: string,
): Promise<SupportConversationView | null> {
  const me = await gate("support.getSupportConversation");
  const c = state.supportConversations.find((x) => x.code === code);
  if (!c || !sees(me, c.projectId)) return null;
  return conversationView(me, c);
}

export interface CustomerPreview {
  status: CustomerStatus;
  /** Il triage e il team sono «noi»: mai un nome, una bozza, una stima, un commento. */
  messages: { from: "customer" | "us"; body: string; at: string }[];
}

/** «Anteprima del cliente»: esattamente ciò che vede lui adesso. */
export async function customerPreview(code: string): Promise<CustomerPreview | null> {
  const me = await gate("support.customerPreview");
  const c = state.supportConversations.find((x) => x.code === code);
  if (!c || !sees(me, c.projectId)) return null;
  return {
    status: customerStatusOf(requestOf(c)),
    messages: c.messages.map((m) => ({
      from: m.from === "customer" ? ("customer" as const) : ("us" as const),
      body: m.body,
      at: m.at,
    })),
  };
}

/** Il blocco «Clienti in attesa» della Home: aspettano noi, dove ho `support.reply`. */
export async function listWaitingCustomers(): Promise<SupportConversationView[]> {
  const me = await gate("support.listWaitingCustomers");
  return state.supportConversations
    .filter((c) => sees(me, c.projectId) && holds(me, "support.reply", c.projectId))
    .filter((c) => supportState(c) === "waiting_us")
    .sort(
      (a, b) => waitingSince(a)!.localeCompare(waitingSince(b)!) || a.code.localeCompare(b.code),
    )
    .map((c) => conversationView(me, c));
}

export type SupportWidgetView = SupportWidget & { conversationCount: number };

export interface WidgetList {
  /** `widget.manage`: senza, l'elenco è vuoto (i widget non si vedono). */
  canManage: boolean;
  widgets: SupportWidgetView[];
}

export async function listWidgets(projectId: string): Promise<WidgetList> {
  const me = await gate("support.listWidgets");
  if (!sees(me, projectId) || !holds(me, "widget.manage", projectId)) {
    return { canManage: false, widgets: [] };
  }
  return {
    canManage: true,
    widgets: state.supportWidgets
      .filter((w) => w.projectId === projectId)
      .map((w) => ({
        ...structuredClone(w),
        conversationCount: state.supportConversations.filter((c) => c.widgetId === w.id).length,
      })),
  };
}

export interface MyRequestStatus {
  code: string;
  title: string;
  status: CustomerStatus;
}

/**
 * Lo stato di una richiesta come lo dice `my_requests` al cliente che l'ha
 * aperta dal server MCP: codice, titolo e stato in parole, nient'altro.
 */
export async function myRequestStatus(requestId: string): Promise<MyRequestStatus | null> {
  const me = await gate("support.myRequestStatus");
  const req = state.requests.find((r) => r.id === requestId);
  if (!req || !sees(me, req.projectId)) return null;
  return { code: req.code, title: req.title, status: customerStatusOf(req) };
}

export interface SupportSearchResult {
  kind: "support";
  id: string;
  code: string;
  label: string;
  route: string;
  state: SupportState;
}

/** ⌘K: le conversazioni per codice, cliente o desiderio, nei progetti che chi cerca vede. */
export async function searchSupport(q: string): Promise<SupportSearchResult[]> {
  const me = await gate("support.searchSupport");
  const needle = fold(q.trim());
  if (!needle) return [];
  return state.supportConversations
    .filter((c) => sees(me, c.projectId))
    .filter((c) =>
      [c.code, c.customer.name, c.rewrittenWish ?? ""].some((f) => fold(f).includes(needle)),
    )
    .map((c) => ({
      kind: "support" as const,
      id: c.id,
      code: c.code,
      label: c.customer.name,
      route: supportHref(c.projectId, c.code),
      state: supportState(c),
    }));
}
