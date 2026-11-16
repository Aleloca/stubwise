// L'import circolare con `api-mutations` è innocuo: `insertRequest` si usa
// solo dentro le funzioni.
import { insertRequest } from "../api-mutations";
import { supportState, wishTitle } from "../../domain/support/state";
import { newId, now, state } from "../store";
import type { SupportConversation, SupportMessage } from "../types";
import { invalid, writer } from "../writer";
import {
  conversationFor,
  conversationView,
  publishSupportRequest,
  type SupportConversationView,
} from "./visibility";

// SOLO PROTOTIPO: ciò che nel motore arriva dal canale (il widget, il server
// MCP) e che qui si simula coi «Simula …» della UI: un messaggio del
// cliente, il cliente che se ne va, il triage che finisce. L'avviso della
// richiesta passa da `publishSupportRequest`. Nessuna di queste funzioni scrive al
// cliente né nella Posta.

const push = (c: SupportConversation, from: SupportMessage["from"], body: string) =>
  c.messages.push({ id: newId("sup-m"), from, authorId: null, body, at: now() });

const hasOutcome = (c: SupportConversation) => c.requestId !== null || c.taskId !== null;

/** Il prossimo `<PRJ>-S<n>` del progetto, dal contatore: mai riusato. */
function nextCode(projectId: string): string {
  const n = (state.supportCodeSeq.get(projectId) ?? 0) + 1;
  state.supportCodeSeq.set(projectId, n);
  return `${state.projectsById.get(projectId)!.code}-S${n}`;
}

/**
 * Dove va un messaggio del cliente (area 8, F3, S17): una conversazione con
 * un esito è CHIUSA, e il messaggio va alla sua successiva — si segue la
 * catena fino alla prima senza esito; se non c'è, se ne apre una (stesso
 * canale, widget e cliente) e la si lega. Senza esito, la stessa.
 */
function receiverOf(c: SupportConversation): SupportConversation {
  let cur = c;
  while (hasOutcome(cur)) {
    const next = cur.continuedInId
      ? state.supportConversations.find((x) => x.id === cur.continuedInId)
      : undefined;
    if (next) {
      cur = next;
      continue;
    }
    const fresh: SupportConversation = {
      id: newId("sup"),
      code: nextCode(cur.projectId),
      projectId: cur.projectId,
      channel: cur.channel,
      widgetId: cur.widgetId,
      customer: { ...cur.customer },
      messages: [],
      rewrittenWish: null,
      requestId: null,
      taskId: null,
      triage: null,
      confirmedAt: null,
      // API per i siti (S6, 72): la catena non promuove. La successiva è
      // verificata solo se nasce con un token valido, e il messaggio simulato
      // non ne porta.
      identityVerified: false,
    };
    state.supportConversations.push(fresh);
    cur.continuedInId = fresh.id;
    return fresh;
  }
  return cur;
}

/**
 * «Simula un messaggio del cliente». Su una «non conclusa» il triage
 * riprende (shape [A 2]); su una conversazione con un esito apre (o
 * raggiunge) la successiva, e restituisce quella. Nessun avviso.
 */
export async function simulateCustomerMessage(
  code: string,
  body: string,
): Promise<SupportConversationView> {
  const me = await writer("support.simulateCustomerMessage");
  const c = conversationFor(me, code);
  const text = body.trim();
  if (!text) throw invalid("body");
  const target = receiverOf(c);
  // Un messaggio nuovo rende vecchio il giudizio dopo il silenzio (lo stato lo deriva da sé).
  push(target, "customer", text);
  return conversationView(me, target);
}

/** «Simula: il cliente se ne va» durante il triage: non conclusa, nessuna richiesta. */
export async function simulateCustomerLeaves(code: string): Promise<SupportConversationView> {
  const me = await writer("support.simulateCustomerLeaves");
  const c = conversationFor(me, code);
  if (supportState(c) !== "triage") throw invalid("state");
  // Area 8, F3: il controllo dopo il silenzio la giudica non conclusa.
  c.triage = { outcome: "not_concluded", at: now(), byUserId: null };
  return conversationView(me, c);
}

/** Il titolo della richiesta: la prima frase del desiderio, al massimo 80 caratteri. */

/**
 * «Simula: triage concluso»: il triage propone il desiderio riscritto, il
 * cliente conferma e la richiesta nasce con la conversazione allegata. Chi
 * la apre è il cliente (nessuna persona fra i richiedenti, nessun
 * `backlog.create` da chiedere a chi simula). Avviso `support.request`.
 */
export async function simulateTriageDone(code: string): Promise<SupportConversationView> {
  const me = await writer("support.simulateTriageDone");
  const c = conversationFor(me, code);
  if (supportState(c) !== "triage") throw invalid("state");
  const wish =
    c.rewrittenWish ?? c.messages.find((m) => m.from === "customer")?.body ?? c.customer.name;
  push(c, "triage", `Is this what you need? “${wish}”`);
  push(c, "customer", "Yes, that's it.");
  push(c, "triage", "Thanks: I passed your request to the team.");
  c.rewrittenWish = wish;
  c.confirmedAt = now();
  const project = state.projectsById.get(c.projectId)!;
  const req = insertRequest(
    project,
    {
      projectId: project.id,
      title: wishTitle(wish),
      description: wish,
      origin: { kind: "support", conversationId: c.id },
    },
    [],
    { triage: true },
  );
  publishSupportRequest(req);
  return conversationView(me, c);
}
