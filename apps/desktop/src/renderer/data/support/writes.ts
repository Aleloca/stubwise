import { normalizeWidgetOrigin, WIDGET_MAX_ORIGINS } from "@stubwise/shared";
// Le scritture usano `createRequestAs` solo dentro le funzioni: l'import
// circolare con `api-mutations` è innocuo.
import { createRequestAs } from "../api-mutations";
import { rotateWidgetIdentitySecret } from "../projectSettings/widgetIdentity";
import { requireReauth } from "../auth/reauth";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
// Per effetto: registra i tipi di voce di progetto (`recordChange` lancia su uno ignoto).
import "../projectSettings/changeTypes";
import { copy, newId, now, state } from "../store";
import type { SupportWidget } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { supportState } from "../../domain/support/state";
import {
  conversationFor,
  conversationView,
  holds,
  publishSupportRequest,
  sees,
  type SupportConversationView,
} from "./visibility";

// Le scritture di Support. Il team non scrive MAI al cliente del widget (area
// 8, F3, decisione del maintainer): risponde solo ai collaboratori interni del
// canale `mcp`, dal clic di chi ha `support.manage` (`replyToCollaborator`).
// Nessuna di queste funzioni scrive nella Posta.
// Una richiesta nasce solo da una conversazione (mai da un'email). Gli
// errori: `not_found` per ciò che chi agisce non vede (R-G5), `forbidden`
// per ciò che vede ma non può fare, `invalid: <cosa>` per un input sbagliato.

/** Un widget nel registro: il nome com'è, l'id del widget. */
const widgetObject = (w: SupportWidget) => ({ type: "widget", id: w.id, label: w.name });

function replierFor(me: string, code: string) {
  const c = conversationFor(me, code);
  if (!holds(me, "support.manage", c.projectId)) throw forbidden();
  return c;
}

/**
 * La risposta al collaboratore (canale `mcp`): un messaggio del team, che gli
 * arriva con `my_requests`. Su una conversazione del widget `invalid:
 * channel`, qualunque sia lo stato, e nessun messaggio (il 409
 * `support_widget_no_reply` del server). Nessun avviso, nessuna email.
 */
export async function replyToCollaborator(
  code: string,
  body: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- l'id dell'invio è per il server (un doppio invio è uno solo): il prototipo non ne ha bisogno
  _clientId?: string,
): Promise<SupportConversationView> {
  const me = await writer("support.replyToCollaborator");
  const c = replierFor(me, code);
  if (c.channel !== "mcp") throw invalid("channel");
  const text = body.trim();
  if (!text) throw invalid("body");
  c.messages.push({ id: newId("sup-m"), from: "team", authorId: me, body: text, at: now() });
  return conversationView(me, c);
}

/**
 * «Apri la richiesta» su una conversazione non conclusa (`support.manage` e
 * `backlog.create`):
 * la richiesta nasce con la conversazione allegata. Un secondo clic (o due
 * chiamate sovrapposte) restituisce la stessa.
 */
export async function openRequestFrom(
  code: string,
  input: { title: string; description: string },
): Promise<SupportConversationView> {
  const me = await writer("support.openRequestFrom");
  const c = replierFor(me, code);
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
 * «Not concluded» su una conversazione `answered` (area 8, F3, decisione del
 * maintainer): chi ha `support.manage` non è d'accordo col giudizio dopo il
 * silenzio, e la rimette fra quelle che aspettano il team (non conclusa: si
 * può aprire la richiesta). Il giudizio porta il suo nome; un messaggio nuovo
 * del cliente lo rende vecchio come ogni giudizio. Su una già non conclusa
 * restituisce la stessa vista.
 */
export async function markNotConcluded(code: string): Promise<SupportConversationView> {
  const me = await writer("support.markNotConcluded");
  const c = replierFor(me, code);
  const st = supportState(c);
  if (st === "not_concluded") return conversationView(me, c);
  if (st !== "answered") throw invalid("state");
  c.triage = { outcome: "not_concluded", at: now(), byUserId: me };
  return conversationView(me, c);
}

// --- widget -------------------------------------------------------------------

/** I campi che si scrivono (R-K13): quelli del web. Nuovo: solo il nome è obbligatorio. */
export type WidgetFields = Omit<
  SupportWidget,
  "id" | "projectId" | "createdAt" | "identitySecretSet" | "identitySecretRotatedAt"
>;
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
  identityRequired: false,
};

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
function cleanWidget(
  projectId: string,
  patch: Partial<WidgetFields>,
  secretSet: boolean,
): Partial<WidgetFields> {
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
    // Una regola sola col server (area 8, F3, S16): `https://host[:porta]`, `http`
    // solo per localhost, niente percorso, al più 20; una voce cattiva rifiuta tutto.
    const list = patch.origins;
    const normal = Array.isArray(list)
      ? list.map((o) => (typeof o === "string" ? normalizeWidgetOrigin(o) : null))
      : null;
    if (!normal || normal.some((o) => o === null)) throw invalid("origins");
    const unique = [...new Set(normal as string[])];
    if (unique.length > WIDGET_MAX_ORIGINS) throw invalid("origins");
    out.origins = unique;
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
  if (patch.identityRequired !== undefined) {
    // Senza un segreto nessun sito può firmare un token: acceso, il widget
    // non accetterebbe più nessuno.
    if (typeof patch.identityRequired !== "boolean" || (patch.identityRequired && !secretSet))
      throw invalid("identityRequired");
    out.identityRequired = patch.identityRequired;
  }
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
  const fields = cleanWidget(projectId, { ...input, name: input.name ?? "" }, false);
  const w: SupportWidget = {
    id: newId("wdg"),
    projectId,
    ...WIDGET_DEFAULTS,
    ...fields,
    name: fields.name!,
    identitySecretSet: false,
    identitySecretRotatedAt: null,
    createdAt: now(),
  };
  state.supportWidgets.push(w);
  recordChange({ kind: "widget.created", actorId: me, projectId, object: widgetObject(w) });
  return copy(w);
}

/** Cambia i campi passati, gli altri restano (patch). Tutto o niente: un campo sbagliato non scrive. */
export async function updateWidget(
  id: string,
  patch: Partial<WidgetFields>,
): Promise<SupportWidget> {
  const me = await writer("support.updateWidget");
  const w = widgetFor(me, id);
  const fields = cleanWidget(w.projectId, patch, w.identitySecretSet);
  const before = { name: w.name };
  Object.assign(w, fields);
  // Del widget il registro dice il nome; gli altri campi hanno la frase.
  const diff = changedFields(before, { name: w.name });
  recordChange({
    kind: "widget.updated",
    actorId: me,
    projectId: w.projectId,
    object: widgetObject(w),
    ...(diff ? { before: diff.before, after: diff.after } : {}),
  });
  return copy(w);
}

/**
 * API per i siti (S6): un segreto d'identità dei clienti nuovo (+R,
 * `widget.manage`). Il valore esce qui e mai più; quello di prima smette di
 * valere SUBITO (D-5). La traccia è la data, mai il segreto.
 */
export async function regenerateIdentitySecret(
  id: string,
): Promise<
  { ok: true; secret: string; rotatedAt: string } | { ok: false; error: "reauth_required" }
> {
  const me = await writer("support.regenerateIdentitySecret");
  const w = widgetFor(me, id);
  if (requireReauth(me, "support.regenerateIdentitySecret")) {
    return { ok: false, error: "reauth_required" };
  }
  const secret = rotateWidgetIdentitySecret(w.id);
  w.identitySecretSet = true;
  w.identitySecretRotatedAt = now();
  return { ok: true, secret, rotatedAt: w.identitySecretRotatedAt };
}

/** Elimina il widget; le sue conversazioni restano in Support. */
export async function deleteWidget(id: string): Promise<void> {
  const me = await writer("support.deleteWidget");
  const w = widgetFor(me, id);
  state.supportWidgets = state.supportWidgets.filter((x) => x !== w);
  recordChange({
    kind: "widget.deleted",
    actorId: me,
    projectId: w.projectId,
    object: widgetObject(w),
  });
}
