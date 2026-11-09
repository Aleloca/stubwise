import { currentVia } from "../claude/via";
import { newId, nextSeq, now, state } from "../store";
import { changeTypeOf } from "./registry";
import type { ChangeEntry, ChangeInput } from "./types";

export { changeTypeOf, changeTypes, registerChangeTypes } from "./registry";

// La scrittura del registro: `recordChange`. Il registro dei tipi sta in
// `registry.ts` (puro: lo legge anche la build app) ed è codice, non stato:
// `resetApi` non lo svuota.

/**
 * Scrive una voce. Si chiama DENTRO la scrittura, solo a scrittura riuscita
 * (dopo il cancello e i controlli, insieme al cambio di stato). Un tipo non
 * registrato, o una voce che non rispetta il livello del tipo, lancia: è un
 * difetto di chi scrive, non un input sbagliato.
 */
export function recordChange(input: ChangeInput): void {
  const type = changeTypeOf(input.kind);
  if (!type) throw new Error(`Unregistered change type: ${input.kind}`);
  if ((type.scope === "project") !== (input.projectId !== null))
    throw new Error(`Change type ${input.kind} is ${type.scope}-scoped`);
  const entry: ChangeEntry = {
    id: newId("chg"),
    kind: input.kind,
    at: now(),
    actorId: input.actorId,
    projectId: input.projectId,
    object: Object.freeze({ ...input.object }),
    before: input.before ?? null,
    after: input.after ?? null,
    params: Object.freeze({ ...input.params }),
    // L'ordine del «com'era» di «Annulla» (area 10a, P4): `at` è fermo.
    seq: nextSeq(),
  };
  // Il segno «per conto di» (area 10a): da `currentVia()`, mai dall'input.
  const via = currentVia();
  if (via) {
    entry.via = "claude";
    entry.claudeActionId = via.actionId;
    if (via.undoOfActionId !== null) {
      // Dentro un «Annulla»: la voce dell'azione annullata sullo stesso oggetto.
      const undone = [...state.changelog]
        .reverse()
        .find((e) => e.object.id === input.object.id && e.claudeActionId === via.undoOfActionId);
      if (undone) entry.undoOf = undone.id;
    }
  }
  // Solo in aggiunta: una voce non si modifica né si cancella.
  state.changelog.push(Object.freeze(entry));
}
