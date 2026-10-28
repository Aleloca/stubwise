// Le scritture usano `createRequestAs` solo dentro le funzioni: l'import
// circolare con `api-mutations` è innocuo.
import { createRequestAs } from "../api-mutations";
import { mailboxOf } from "../mail/compose";
import { copy, newId, now, state } from "../store";
import type { MailDraft, SupportWidget } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { supportMailSlot, supportState } from "../../domain/support/state";
import {
  conversationFor,
  conversationView,
  draftText,
  holds,
  publishSupportRequest,
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
 * Durante il triage le domande al cliente le fa Claude: né la risposta né
 * la sua bozza (R-K15, `invalid: state`). Su una «non conclusa» si risponde.
 */
function openReplyFor(me: string, code: string) {
  const c = replierFor(me, code);
  if (supportState(c) === "triage") throw invalid("state");
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
  const c = openReplyFor(me, code);
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
  const c = openReplyFor(me, code);
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
  publishSupportRequest(req);
  return conversationView(me, c);
}

/**
 * «Segui»: l'avviso obbligatorio `support.customer_replied` a ogni messaggio
 * nuovo del cliente. Segue chiunque veda la conversazione, cioè ogni membro
 * del progetto (R-K12); rispondere resta a chi ha `support.reply`.
 */
export async function followConversation(
  code: string,
  on: boolean,
): Promise<SupportConversationView> {
  const me = await writer("support.followConversation");
  const c = conversationFor(me, code);
  c.followerIds = c.followerIds.filter((id) => id !== me);
  if (on) c.followerIds.push(me);
  return conversationView(me, c);
}

/**
 * «Scrivigli anche per email»: la bozza da aprire nel compositore della
 * Posta (area 6), dalla casella di chi scrive, col testo di Claude. NON la
 * salva e NON la invia: la manda una persona, dalla Posta. È sempre
 * un'email nuova, nello slot della conversazione (`support-<codice>`,
 * R-K14): accanto alla «nuova email» di chi scrive, mai al suo posto, e mai
 * dentro una conversazione della Posta (la cui bozza sovrascriverebbe).
 */
export async function emailDraftFor(
  code: string,
): Promise<{ threadId: string | null; draft: MailDraft }> {
  const me = await writer("support.emailDraftFor");
  // Nemmeno l'email durante il triage: Claude sta facendo le domande (R-K18).
  const c = openReplyFor(me, code);
  const email = c.customer.email;
  if (!email) throw invalid("no_email");
  mailboxOf(me);
  const req = requestOf(c);
  const slot = supportMailSlot(c.code);
  const draft: MailDraft = {
    id: `md-${me}-${slot}`,
    personId: me,
    threadId: null,
    mode: "new",
    slot,
    replyToMessageId: null,
    to: [{ name: c.customer.name, email, personId: null }],
    cc: [],
    subject: req ? `About your request ${req.code}` : "About your message",
    body: draftText(c),
    attachments: [],
    updatedAt: now(),
  };
  return { threadId: null, draft };
}

// --- widget -------------------------------------------------------------------

/** I campi che si scrivono (R-K13): quelli del web. Nuovo: solo il nome è obbligatorio. */
export type WidgetFields = Omit<SupportWidget, "id" | "projectId" | "createdAt">;
export type WidgetInput = Pick<WidgetFields, "name"> & Partial<WidgetFields>;

/** I default del web (`widgetSettingsSchema`), coi testi in inglese del prototipo. */
const WIDGET_DEFAULTS: Omit<WidgetFields, "name"> = {
  enabled: false,
  sourceRepositoryIds: [],
  origins: [],
  title: "Help",
  welcomeMessage: "Hi! How can we help?",
  instructions: "",
  accentColor: "#22c55e",
  language: "it",
  dailyMessageCap: null,
  dailyRequestCap: null,
};

const ORIGIN = /^https?:\/\/[^\s/]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Il tetto massimo di un limite giornaliero, come sul web. */
const MAX_DAILY_CAP = 100_000;

/** Un testo obbligatorio fra 1 e `max` caratteri (dopo `trim`), altrimenti `invalid: <field>`. */
function text(value: string, field: string, max: number, required = true): string {
  if (typeof value !== "string") throw invalid(field);
  const v = value.trim();
  if ((required && !v) || v.length > max) throw invalid(field);
  return v;
}

function cap(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAILY_CAP) throw invalid(field);
  return value;
}

/**
 * I campi di `patch` controllati e ripuliti, con le regole del web
 * (`widgetUpsertBodySchema`). Gli errori sono codici: `invalid: <campo>`.
 * Le fonti della documentazione sono repository dello stesso progetto.
 */
function cleanWidget(projectId: string, patch: Partial<WidgetFields>): Partial<WidgetFields> {
  const out: Partial<WidgetFields> = {};
  if (patch.name !== undefined) out.name = text(patch.name, "name", 80);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw invalid("enabled");
    out.enabled = patch.enabled;
  }
  if (patch.sourceRepositoryIds !== undefined) {
    const ids = patch.sourceRepositoryIds;
    const own = (id: string) =>
      state.repositories.some((r) => r.id === id && r.projectId === projectId);
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(own)) {
      throw invalid("sourceRepositoryIds");
    }
    out.sourceRepositoryIds = [...new Set(ids)];
  }
  if (patch.origins !== undefined) {
    const list = patch.origins;
    if (!Array.isArray(list) || list.some((o) => typeof o !== "string" || !ORIGIN.test(o.trim())))
      throw invalid("origins");
    out.origins = [...new Set(list.map((o) => o.trim()))];
  }
  if (patch.title !== undefined) out.title = text(patch.title, "title", 80);
  if (patch.welcomeMessage !== undefined)
    out.welcomeMessage = text(patch.welcomeMessage, "welcomeMessage", 500);
  if (patch.instructions !== undefined)
    out.instructions = text(patch.instructions, "instructions", 4000, false);
  if (patch.accentColor !== undefined) {
    if (typeof patch.accentColor !== "string" || !COLOR.test(patch.accentColor))
      throw invalid("accentColor");
    out.accentColor = patch.accentColor;
  }
  if (patch.language !== undefined) {
    if (patch.language !== "it" && patch.language !== "en") throw invalid("language");
    out.language = patch.language;
  }
  if (patch.dailyMessageCap !== undefined)
    out.dailyMessageCap = cap(patch.dailyMessageCap, "dailyMessageCap");
  if (patch.dailyRequestCap !== undefined)
    out.dailyRequestCap = cap(patch.dailyRequestCap, "dailyRequestCap");
  return out;
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
  const fields = cleanWidget(projectId, { ...input, name: input.name ?? "" });
  const w: SupportWidget = {
    id: newId("wdg"),
    projectId,
    ...WIDGET_DEFAULTS,
    ...fields,
    name: fields.name!,
    createdAt: now(),
  };
  state.supportWidgets.push(w);
  return copy(w);
}

/** Cambia i campi passati, gli altri restano (patch). Tutto o niente: un campo sbagliato non scrive. */
export async function updateWidget(
  id: string,
  patch: Partial<WidgetFields>,
): Promise<SupportWidget> {
  const me = await writer("support.updateWidget");
  const w = widgetFor(me, id);
  Object.assign(w, cleanWidget(w.projectId, patch));
  return copy(w);
}

/** Elimina il widget; le sue conversazioni restano in Support. */
export async function deleteWidget(id: string): Promise<void> {
  const me = await writer("support.deleteWidget");
  const w = widgetFor(me, id);
  state.supportWidgets = state.supportWidgets.filter((x) => x !== w);
}
