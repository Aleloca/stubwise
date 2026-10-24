import type { Answer } from "../answers";
import type { IntentContext } from "../context";

/** Una domanda che il motore non riconosce: una risposta generica, nessuna azione. */
export async function general(_text: string, ctx: IntentContext): Promise<Answer> {
  return { actions: [], text: ctx.t("claude.answers.general") };
}
