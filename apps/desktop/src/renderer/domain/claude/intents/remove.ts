import { labelled, named, resulted, summarized, type Answer } from "../answers";
import type { IntentContext } from "../context";
import { findCodes } from "../parse";
import { byClass } from "./change";

/**
 * «Elimina ACQ-14» (area 10a): propone `deleteTask`. La classe la dice il
 * livello dati (`ctx.classify`): l'eliminazione non si annulla, quindi è
 * una scheda B e non parte mai all'invio. Un codice che chi chiede non vede
 * e uno che non esiste (o una task già eliminata) danno la stessa frase.
 */
export async function remove(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const ref = findCodes(text).find((c) => c.kind === "task");
  if (!ref) return { actions: [], text: t("claude.answers.remove.noCode") };
  const lookup = {
    tool: "get_ticket",
    ...labelled(t, "claude.answers.actions.lookup", { code: ref.code }),
  };
  const task = await ctx.read.getTaskByCode(ref.code);
  if (!task) {
    return {
      actions: [{ ...lookup, ...resulted(t, "claude.answers.actions.notFound") }],
      text: t("claude.answers.explain.notFound", { code: ref.code }),
    };
  }
  const params = { task: named(task) };
  return {
    actions: [lookup],
    refs: [{ kind: "task", id: task.id }],
    ...(await byClass(
      ctx,
      {
        fn: "deleteTask",
        args: { id: task.id },
        // Il nome tra virgolette, come la creazione (rifinitura 3 di Impeccable).
        ...summarized(t, "claude.answers.remove.summary", { code: task.code, title: task.title }),
      },
      t("claude.answers.remove.done", { code: task.code }),
      t("claude.answers.remove.proposal", params),
    )),
  };
}
