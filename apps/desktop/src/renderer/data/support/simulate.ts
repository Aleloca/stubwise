// L'import circolare con `api-mutations` è innocuo: `insertRequest` si usa
// solo dentro le funzioni.
import { insertRequest } from "../api-mutations";
import { publishAlert } from "../alerts/publish";
import { supportState } from "../../domain/support/state";
import { CLAUDE_ID } from "../seed/people";
import { newId, now, state } from "../store";
import type { SupportConversation, SupportMessage } from "../types";
import { invalid, writer } from "../writer";
import {
  conversationFor,
  conversationView,
  draftText,
  requestHref,
  supportHref,
  type SupportConversationView,
} from "./visibility";

// SOLO PROTOTIPO: ciò che nel motore arriva dal canale (il widget, il server
// MCP) e che qui si simula coi «Simula …» della UI: un messaggio del
// cliente, il cliente che se ne va, il triage che finisce. Gli avvisi
// passano tutti da `publishAlert`. Nessuna di queste funzioni scrive al
// cliente né nella Posta.

const push = (c: SupportConversation, from: SupportMessage["from"], body: string) =>
  c.messages.push({ id: newId("sup-m"), from, authorId: null, body, at: now() });

/**
 * «Simula un messaggio del cliente». Su una «non conclusa» il triage
 * riprende (shape [A 2]); su una conversazione con richiesta Claude prepara
 * la bozza della risposta (che non parte da sola). Avviso obbligatorio a chi
 * la segue.
 */
export async function simulateCustomerMessage(
  code: string,
  body: string,
): Promise<SupportConversationView> {
  const me = await writer("support.simulateCustomerMessage");
  const c = conversationFor(me, code);
  const text = body.trim();
  if (!text) throw invalid("body");
  push(c, "customer", text);
  if (c.requestId === null) c.leftAt = null;
  if (supportState(c) === "waiting_us") c.claudeDraft = draftText(c);
  publishAlert({
    kind: "support.customer_replied",
    projectId: c.projectId,
    objectCode: c.code,
    title: "The customer replied",
    body: `${c.customer.name}: ${text}`,
    link: supportHref(c.projectId, c.code),
    mandatory: c.followerIds
      .filter((id) => id !== CLAUDE_ID)
      .map((personId) => ({ personId, reason: "follows_conversation" as const })),
  });
  return conversationView(me, c);
}

/** «Simula: il cliente se ne va» durante il triage: non conclusa, nessuna richiesta. */
export async function simulateCustomerLeaves(code: string): Promise<SupportConversationView> {
  const me = await writer("support.simulateCustomerLeaves");
  const c = conversationFor(me, code);
  if (supportState(c) !== "triage") throw invalid("state");
  c.leftAt = now();
  return conversationView(me, c);
}

/** Il titolo della richiesta: la prima frase del desiderio, al massimo 80 caratteri. */
function titleOf(wish: string): string {
  const first = wish.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

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
  push(c, "triage", "Thanks: I passed your request to the team. You'll find the answer here.");
  c.rewrittenWish = wish;
  const project = state.projectsById.get(c.projectId)!;
  const req = insertRequest(
    project,
    {
      projectId: project.id,
      title: titleOf(wish),
      description: wish,
      origin: { kind: "support", conversationId: c.id },
    },
    [],
  );
  publishAlert({
    kind: "support.request",
    projectId: project.id,
    objectCode: req.code,
    title: "New request from a customer",
    body: req.title,
    link: requestHref(req),
  });
  return conversationView(me, c);
}
