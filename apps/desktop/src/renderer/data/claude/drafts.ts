import i18n from "../../i18n";
import { draftReply, hintSentence } from "../../domain/claude/intents/mailDraft";
import { holds, sees } from "../access";
import { draftContext } from "../mail/compose";
import { threadFor } from "../mail/reads";
import { state } from "../store";

// Le bozze di Claude nella Posta e nella descrizione di una task (area 10b,
// Task 8, D1): i testi che il riquadro mette nel campo, letti con le letture
// di chi chiede. Nessuna funzione qui scrive: un'email parte solo con «Send»
// e una descrizione cambia solo con «Save», gesti della persona. Le parole
// intorno ai dati sono nella lingua di chi chiede (come «Ask Claude»): la
// bozza è contenuto scritto da Claude, non una frase da rileggere.

/** Ha una casella: l'email nuova si scrive solo dalla propria (`mailbox_owner`). */
const hasMailbox = (me: string) => state.mailboxes.some((b) => b.personId === me);

/**
 * La bozza del corpo di un'email: `draftReply` (`domain/claude/intents/mailDraft.ts`,
 * la stessa di «Ask Claude» della Posta) con le letture di chi chiede.
 * `not_found` se la conversazione non è nella sua casella; un'email nuova senza
 * indicazione è `{ ok: false, reason: "hint" }`.
 */
export async function mailDraftFor(
  me: string,
  threadId: string | null,
  hint: string,
): Promise<
  { ok: true; text: string; used: string[] } | { ok: false; reason: "not_found" | "hint" }
> {
  if (threadId === null ? !hasMailbox(me) : !threadFor(me, threadId)) {
    return { ok: false, reason: "not_found" };
  }
  if (threadId === null && hintSentence(hint) === "") return { ok: false, reason: "hint" };
  const draft = await draftReply({ threadId, hint }, draftContext(me));
  return { ok: true, text: draft.text, used: draft.used.map((u) => u.code) };
}

const K = "claude.descriptionDraft";

/**
 * La bozza della descrizione di una task: dalla richiesta d'origine (titolo,
 * descrizione, urgenza) e dalla conversazione di supporto da cui viene, solo
 * se chi chiede le vede. Senza `tickets.edit` sul progetto: `forbidden`;
 * senza fonti: `no_source` (Claude non inventa una descrizione).
 */
export function taskDescriptionDraftFor(
  me: string,
  taskId: string,
):
  | { ok: true; text: string; sources: string[] }
  | { ok: false; reason: "not_found" | "forbidden" | "no_source" } {
  const task = state.tasksById.get(taskId);
  if (!task || !state.tasks.includes(task) || !sees(me, task.projectId)) {
    return { ok: false, reason: "not_found" };
  }
  if (!holds(me, "tickets.edit", task.projectId)) return { ok: false, reason: "forbidden" };
  const t = i18n.t.bind(i18n);
  const parts: string[] = [];
  const sources: string[] = [];
  const req = task.requestId ? state.requests.find((r) => r.id === task.requestId) : undefined;
  if (req && sees(me, req.projectId)) {
    parts.push(
      t(`${K}.request`, {
        code: req.code,
        title: req.title,
        level: t(`claude.answers.explain.level.${req.urgency}`),
      }),
    );
    if (req.description.trim()) parts.push(req.description.trim());
    sources.push(req.code);
    const origin = req.origin?.kind === "support" ? req.origin.conversationId : null;
    const c = origin ? state.supportConversations.find((x) => x.id === origin) : undefined;
    const said = c?.messages.find((m) => m.from === "customer")?.body;
    if (c && said && sees(me, c.projectId)) {
      parts.push(t(`${K}.customer`, { code: c.code, text: said }));
      sources.push(c.code);
    }
  }
  if (parts.length === 0) return { ok: false, reason: "no_source" };
  return { ok: true, text: parts.join("\n\n"), sources };
}
