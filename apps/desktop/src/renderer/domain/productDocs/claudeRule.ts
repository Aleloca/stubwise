import type {
  ProductAnswerChoice,
  ProductFact,
  ProductFactDecision,
} from "../../data/model";

// La regola di Claude sulla doc di prodotto (11b): PURA, senza stato e senza
// orologio. Una modifica entra da sola SOLO se il fatto è chiaro, non
// contraddice un blocco scritto da una persona, e chi agisce ha `docs.edit`;
// in ogni altro caso è una domanda o niente. Claude non scrive mai «deciso»
// per conto suo (anti-obiettivo del maintainer, Global Constraints).

/** Quello che il motore sa e la regola non deve cercare (preflight P5, P6, P7). */
export interface FactContext {
  /** L'ultima mano sull'ancora è di una persona (non di Claude). */
  lastWriterIsPerson: boolean;
  /** Il titolare della fonte ha `docs.edit` nel progetto. */
  actorCanEdit: boolean;
  /**
   * Una persona ha toccato l'ancora DOPO l'arrivo del fatto (`touchedAfter`):
   * il fatto, scritto su un testo che non c'è più, ora lo contraddice. È il
   * ramo di Review Focus 2, che un flag statico del seme non può coprire.
   */
  changedByPersonSinceArrival: boolean;
  /** L'ancora c'è ancora nella pagina. */
  anchorExists: boolean;
}

type QuestionReason = Extract<ProductFactDecision, { kind: "question" }>["reason"];

const question = (reason: QuestionReason): ProductFactDecision => ({ kind: "question", reason });

/** Dice cosa fare di un fatto. L'ordine delle righe è la regola. */
export function decideFact(fact: ProductFact, ctx: FactContext): ProductFactDecision {
  const { change } = fact;
  // Niente da applicare: l'ancora è sparita (in cima alla pagina non c'è ancora da cercare).
  const needsAnchor =
    change.kind === "replace" ||
    (fact.anchorId !== null && (change.kind === "insert_after" || change.kind === "link_task"));
  if (needsAnchor && !ctx.anchorExists) return { kind: "none" };
  // Il lavoro costruito diverge dalla doc: Claude non sceglie fra i due.
  if (change.kind === "diverges") return question("diverges");
  if (fact.clarity === "vague") return question("vague");
  if (fact.contradicts === true || ctx.changedByPersonSinceArrival) {
    return question(
      ctx.lastWriterIsPerson || ctx.changedByPersonSinceArrival ? "contradicts_person" : "contradicts",
    );
  }
  if (!ctx.actorCanEdit) return question("no_permission");
  return { kind: "edit" };
}

/**
 * La risposta che Claude consiglia (shape Q §3.2b, preflight P30). Quella
 * scritta nel fatto vince; altrimenti: vago → «Leave it as is»; contrasto
 * con Claude → «Update it»; con una persona → «Leave it as is»; senza
 * permesso il fatto è chiaro → «Update it»; `diverges` senza un consiglio
 * nel seme → «Leave it as is» (non si riscrive la doc su un'ipotesi).
 */
export function recommendedOf(
  fact: ProductFact,
  decision: Extract<ProductFactDecision, { kind: "question" }>,
): ProductAnswerChoice {
  if (fact.recommended) return fact.recommended;
  switch (decision.reason) {
    case "contradicts":
    case "no_permission":
      return "apply";
    case "vague":
    case "contradicts_person":
    case "diverges":
      return "keep";
  }
}
