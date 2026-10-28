// Le scritture usano `createRequestAs` solo dentro le funzioni: l'import
// circolare con `api-mutations` è innocuo.
import { createRequestAs } from "../api-mutations";
import { mailboxOf } from "../mail/compose";
import { visibleMessages } from "../mail/visibility";
import { copy, newId, now, state } from "../store";
import type { MailDraft, SupportWidget } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { supportState } from "../../domain/support/state";
import {
  conversationFor,
  conversationView,
  draftText,
  holds,
  requestOf,
  sees,
  type SupportConversationView,
} from "./visibility";

// Le scritture di Support. NESSUNA risposta parte da sola e NESSUNA email
// automatica al cliente: Claude prepara solo bozze (`draftReply`,
// `emailDraftFor`), ogni risposta parte dal clic di chi ha `support.reply`
// (`replyToCustomer`), e nessuna di queste funzioni scrive nella Posta.
// Una richiesta nasce solo da una conversazione (mai da un'email). Gli
// errori: `not_found` per ciò che chi agisce non vede (R-G5), `forbidden`
// per ciò che vede ma non può fare, `invalid: <cosa>` per un input sbagliato.

function replierFor(me: string, code: string) {
  const c = conversationFor(me, code);
  if (!holds(me, "support.reply", c.projectId)) throw forbidden();
  return c;
}

/**
 * «Invia al cliente»: un messaggio del team, che arriva al cliente nel canale
 * da cui ha scritto (widget o Claude Code). Chi risponde segue la
 * conversazione da sé (shape [A 14]); la bozza di Claude, scritta per il
 * messaggio a cui si è appena risposto, non serve più. Nessun avviso, nessuna
 * email.
 */
export async function replyToCustomer(
  code: string,
  body: string,
): Promise<SupportConversationView> {
  const me = await writer("support.replyToCustomer");
  const c = replierFor(me, code);
  const text = body.trim();
  if (!text) throw invalid("body");
  c.messages.push({ id: newId("sup-m"), from: "team", authorId: me, body: text, at: now() });
  if (!c.followerIds.includes(me)) c.followerIds.push(me);
  c.claudeDraft = null;
  return conversationView(me, c);
}

/** «Bozza di Claude»: la rigenera (nel prototipo, un testo deterministico). Non la invia. */
export async function draftReply(code: string): Promise<SupportConversationView> {
  const me = await writer("support.draftReply");
  const c = replierFor(me, code);
  c.claudeDraft = draftText(c);
  return conversationView(me, c);
}

/**
 * «Apri la richiesta» su una conversazione non conclusa (`backlog.create`):
 * la richiesta nasce con la conversazione allegata. Un secondo clic (o due
 * chiamate sovrapposte) restituisce la stessa.
 */
export async function openRequestFrom(
  code: string,
  input: { title: string; description: string },
): Promise<SupportConversationView> {
  const me = await writer("support.openRequestFrom");
  const c = conversationFor(me, code);
  if (!holds(me, "backlog.create", c.projectId)) throw forbidden();
  if (c.requestId !== null) return conversationView(me, c);
  if (supportState(c) !== "not_concluded") throw invalid("state");
  const req = createRequestAs(me, {
    projectId: c.projectId,
    title: input.title,
    description: input.description.trim(),
    origin: { kind: "support", conversationId: c.id },
  });
  c.rewrittenWish ??= req.description || req.title;
  return conversationView(me, c);
}

/**
 * «Segui»: l'avviso obbligatorio `support.customer_replied` a ogni messaggio
 * nuovo del cliente. Il tipo d'avviso vuole `support.reply`, quindi anche
 * seguire.
 */
export async function followConversation(
  code: string,
  on: boolean,
): Promise<SupportConversationView> {
  const me = await writer("support.followConversation");
  const c = replierFor(me, code);
  c.followerIds = c.followerIds.filter((id) => id !== me);
  if (on) c.followerIds.push(me);
  return conversationView(me, c);
}

/** L'ultimo messaggio della Posta che chi scrive vede con l'indirizzo del cliente. */
function lastMailWith(me: string, email: string) {
  const e = email.toLowerCase();
  return visibleMessages(me)
    .filter((x) => [x.from, ...x.to, ...(x.cc ?? [])].some((a) => a.email.toLowerCase() === e))
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

/**
 * «Scrivigli anche per email»: la bozza da aprire nel compositore della
 * Posta (area 6), dalla casella di chi scrive, col testo di Claude. NON la
 * salva e NON la invia: la manda una persona, dalla Posta. `threadId` è la
 * conversazione della Posta con quel cliente, se chi scrive ne vede una
 * (si risponde lì); altrimenti `null`, un'email nuova.
 */
export async function emailDraftFor(
  code: string,
): Promise<{ threadId: string | null; draft: MailDraft }> {
  const me = await writer("support.emailDraftFor");
  const c = replierFor(me, code);
  const email = c.customer.email;
  if (!email) throw invalid("no_email");
  mailboxOf(me);
  const req = requestOf(c);
  const last = lastMailWith(me, email);
  const threadId = last?.threadId ?? null;
  const draft: MailDraft = {
    id: `md-${me}-${threadId ?? "new"}`,
    personId: me,
    threadId,
    mode: threadId ? "reply" : "new",
    replyToMessageId: last?.id ?? null,
    to: [{ name: c.customer.name, email, personId: null }],
    cc: [],
    subject: req ? `About your request ${req.code}` : "About your message",
    body: draftText(c),
    attachments: [],
    updatedAt: now(),
  };
  return { threadId, draft };
}

// --- widget -------------------------------------------------------------------

export interface WidgetInput {
  name: string;
  origins: string[];
  greeting: string;
}

const ORIGIN = /^https?:\/\/[^\s/]+$/;

function checkWidget(input: Partial<WidgetInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw invalid("name");
  if (input.origins !== undefined) {
    if (!Array.isArray(input.origins) || input.origins.some((o) => !ORIGIN.test(o.trim()))) {
      throw invalid("origins");
    }
  }
}

function widgetFor(me: string, id: string): SupportWidget {
  const w = state.supportWidgets.find((x) => x.id === id);
  if (!w || !sees(me, w.projectId)) throw notFound();
  if (!holds(me, "widget.manage", w.projectId)) throw forbidden();
  return w;
}

export async function createWidget(projectId: string, input: WidgetInput): Promise<SupportWidget> {
  const me = await writer("support.createWidget");
  if (!sees(me, projectId)) throw notFound();
  if (!holds(me, "widget.manage", projectId)) throw forbidden();
  checkWidget(input);
  const w: SupportWidget = {
    id: newId("wdg"),
    projectId,
    name: input.name.trim(),
    origins: input.origins.map((o) => o.trim()),
    greeting: input.greeting.trim(),
    createdAt: now(),
  };
  state.supportWidgets.push(w);
  return copy(w);
}

export async function updateWidget(
  id: string,
  patch: Partial<WidgetInput>,
): Promise<SupportWidget> {
  const me = await writer("support.updateWidget");
  const w = widgetFor(me, id);
  checkWidget(patch);
  if (patch.name !== undefined) w.name = patch.name.trim();
  if (patch.origins !== undefined) w.origins = patch.origins.map((o) => o.trim());
  if (patch.greeting !== undefined) w.greeting = patch.greeting.trim();
  return copy(w);
}

/** Elimina il widget; le sue conversazioni restano in Support. */
export async function deleteWidget(id: string): Promise<void> {
  const me = await writer("support.deleteWidget");
  const w = widgetFor(me, id);
  state.supportWidgets = state.supportWidgets.filter((x) => x !== w);
}
