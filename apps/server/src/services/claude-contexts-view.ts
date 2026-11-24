import { agentSessionInputs, type claudeConversations, type Db } from "@stubwise/db";
import { CLAUDE_CONTEXTS_MAX, visibleContexts, type ClaudeContextRef } from "@stubwise/notifications";
import { inArray } from "drizzle-orm";
import { scopeIncludes, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Lotto 8, voce 3: i contesti di una conversazione con Claude come li vede CHI
 * GUARDA (l'autore, o il lettore di una pubblica). Un contesto il cui progetto
 * chi guarda non vede si TOGLIE, nel gruppo e sotto ogni messaggio: in una
 * pubblica il codice di una task o l'id di un progetto altrui non deve uscire
 * (r.1414 del registro; la fuga trovata da 94 nel prototipo). Vale anche per
 * l'autore: un contesto che non vede più esce dal gruppo alla lettura.
 */
export async function contextsForViewer(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  lists: readonly (readonly ClaudeContextRef[])[],
  /** Chi guarda è l'autore della conversazione: i contesti senza progetto (posta, PR) restano a lui solo. */
  isAuthor: boolean,
): Promise<ClaudeContextRef[][]> {
  if (lists.every((l) => l.length === 0)) return lists.map(() => []);
  const scope = await visibleProjectIds(db, viewer);
  return Promise.all(lists.map((l) => visibleContexts(db, l, (projectId) => scopeIncludes(scope, projectId), { isAuthor })));
}

/** I contesti dei messaggi (`agent_session_inputs.contexts`), per id dell'input, già filtrati per chi guarda. */
export async function inputContextsForViewer(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  inputIds: readonly string[],
  isAuthor: boolean,
): Promise<Map<string, ClaudeContextRef[]>> {
  if (inputIds.length === 0) return new Map();
  const rows = await db
    .select({ id: agentSessionInputs.id, contexts: agentSessionInputs.contexts })
    .from(agentSessionInputs)
    .where(inArray(agentSessionInputs.id, [...inputIds]));
  const filtered = await contextsForViewer(db, viewer, rows.map((r) => r.contexts ?? []), isAuthor);
  return new Map(rows.map((r, i) => [r.id, filtered[i]!]));
}

/**
 * Il gruppo dei contesti di una conversazione: `context_refs`, o il solo
 * `context_ref` di una riga di prima. Revisione 8–9 (M-5): dopo un rollback
 * a un server di prima, che scrive solo `context_ref`, il primario può non
 * coincidere con l'ultimo del gruppo: allora si ACCODA (togliendo il doppione).
 */
export function conversationContextGroup(row: Pick<typeof claudeConversations.$inferSelect, "contextRefs" | "contextRef">): ClaudeContextRef[] {
  const group = [...row.contextRefs];
  const primary = row.contextRef;
  if (!primary) return group;
  const last = group.at(-1);
  if (last && last.kind === primary.kind && last.id === primary.id) return group;
  return [...group.filter((c) => !(c.kind === primary.kind && c.id === primary.id)), primary].slice(-CLAUDE_CONTEXTS_MAX);
}
