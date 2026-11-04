import { supportState } from "../../domain/support/state";
import { holds, sees } from "../access";
import { canSeeAutomation } from "../automations/visibility";
import { aiBlockFor } from "../instance/blocks";
import { canEditReleaseNotes } from "../releases/visibility";
import { eventsOf, openDecisions, openQuestion, pendingPlan, state } from "../store";
import { can, viewerFor } from "../viewer";
import { stalledProjectsFor } from "./answersData";

// I suggerimenti discreti «Claude can help you…» (area 10b, Task 12; shape
// `claude-suggestions.md`): una riga sotto la testata di cinque pagine di
// partenza, che scrive una richiesta nella casella del riquadro e non fa
// niente da sola. Qui si decide se la riga c'è e quale, per chi guarda:
// la pagina non chiama `can()`. La riga c'è solo per chi può fare ciò che
// propone (mai un «Who?»), mai accanto a un piano, una domanda o una
// proposta aperti, mai col budget del mese esaurito ([SG 5], P16: il
// riquadro non potrebbe rispondere). Le frasi si compongono a lettura da
// chiavi e parametri; l'unico parametro è il codice dell'oggetto della
// pagina, che chi guarda sta già vedendo (R-G5).

export type SuggestionPlace =
  | { kind: "support"; conversationId: string }
  | { kind: "pr"; prId: string }
  | { kind: "automations"; projectId: string }
  | { kind: "overview"; projectId: string }
  | { kind: "usage" };

export interface ClaudeSuggestion {
  id: "supportReply" | "releaseNotes" | "buildAutomation" | "whyStalled" | "monthSpend";
  /** La riga e la richiesta da scrivere nella casella, nella lingua di chi guarda. */
  lineKey: string;
  promptKey: string;
  /** Il codice dell'oggetto, e `context: "vowel"` per l'«ad» italiano davanti a una vocale. */
  params?: Record<string, string>;
}

/**
 * La chiave di «Not now»: l'oggetto, non il tipo di pagina ([SG 7], maintainer
 * 2 nov 2026). Nascosta su ACQ-S2, la riga resta sulle altre conversazioni.
 */
export function suggestionKeyOf(place: SuggestionPlace): string {
  switch (place.kind) {
    case "support":
      return `support:${place.conversationId}`;
    case "pr":
      return `pr:${place.prId}`;
    case "automations":
    case "overview":
      return `${place.kind}:${place.projectId}`;
    case "usage":
      return "usage";
  }
}

const K = "claude.suggestions";

const suggestion = (
  id: ClaudeSuggestion["id"],
  params?: Record<string, string>,
): ClaudeSuggestion => ({
  id,
  lineKey: `${K}.${id}.line`,
  promptKey: `${K}.${id}.prompt`,
  ...(params ? { params } : {}),
});

/** Il «a»/«ad» italiano davanti al codice: lo sceglie la frase (contesto `vowel`). */
const withVowel = (code: string): Record<string, string> =>
  /^[AEIOU]/i.test(code) ? { code, context: "vowel" } : { code };

/**
 * La task ha qualcosa che aspetta una persona: un piano di Claude in attesa,
 * una domanda di Claude senza risposta o una richiesta di decisione aperta.
 * Un fatto dell'oggetto, non di chi guarda: nasconde la riga e basta.
 */
function taskAwaitsSomeone(taskId: string): boolean {
  if (openDecisions().some((d) => d.taskId === taskId)) return true;
  return state.conversations.some((c) => {
    if (c.taskId !== taskId) return false;
    const log = eventsOf(c.id);
    return Boolean(openQuestion(log) ?? pendingPlan(log));
  });
}

/**
 * Una proposta del polso aperta sul progetto: la card `project.pulse` non
 * archiviata. Il prototipo non ne pubblica (il pulse è del worker): la
 * regola c'è perché la riga non stia mai accanto a una proposta.
 */
const openPulseProposalIn = (projectId: string): boolean =>
  state.notifications.some(
    (n) => n.kind === "project.pulse" && n.projectId === projectId && !n.archived,
  );

/** La riga di una pagina per chi guarda, o `null`. Nessun `can()` nella pagina. */
export function suggestionFor(me: string, place: SuggestionPlace): ClaudeSuggestion | null {
  if (aiBlockFor(null)?.reason === "monthly_budget") return null;
  switch (place.kind) {
    case "support": {
      const c = state.supportConversations.find((x) => x.id === place.conversationId);
      if (!c || !sees(me, c.projectId)) return null;
      if (supportState(c) !== "waiting_us" || !holds(me, "support.reply", c.projectId)) return null;
      return suggestion("supportReply", withVowel(c.code));
    }
    case "pr": {
      const pr = state.openPrs.find((x) => x.id === place.prId);
      if (!pr || pr.state !== "open" || !canEditReleaseNotes(me, pr)) return null;
      if (pr.releaseNotes?.trim()) return null;
      if (pr.taskId && taskAwaitsSomeone(pr.taskId)) return null;
      return suggestion("releaseNotes");
    }
    case "automations": {
      const project = state.projectsById.get(place.projectId);
      if (!project || !sees(me, project.id) || !holds(me, "automations.manage", project.id)) {
        return null;
      }
      const has = state.automations.some(
        (a) => a.projectId === project.id && canSeeAutomation(me, a),
      );
      return has ? null : suggestion("buildAutomation", { code: project.code });
    }
    case "overview": {
      const project = state.projectsById.get(place.projectId);
      if (!project || !sees(me, project.id) || openPulseProposalIn(project.id)) return null;
      // La stessa lettura della risposta S2: la riga non porta mai a «niente di fermo».
      if (stalledProjectsFor(me, project.id).length === 0) return null;
      return suggestion("whyStalled", { code: project.code });
    }
    case "usage":
      return can(viewerFor(me), "usage.view") ? suggestion("monthSpend") : null;
  }
}
