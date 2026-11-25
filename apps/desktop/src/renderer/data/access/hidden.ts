import type { Stall } from "../../domain/stalled";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import type { Task } from "../types";
import { knownPeopleFor } from "./whoCan";

// Il segnaposto delle persone che chi guarda non conosce (registro, A11
// r.1414, decisione del maintainer del 23 nov 2026; la forma è in
// docs/invariants/permissions.md). Come `./whoCan`, non va ri-esportato da
// `./index`: lo store importa quel barile, e `./whoCan` importa lo store.

/**
 * Un masker per UNA risposta: l'id di una persona che `viewerId` non conosce
 * diventa `hidden-<n>`, con `<n>` da 1 nell'ordine in cui compare; la stessa
 * persona ha lo stesso segnaposto in tutta la risposta, mai fra due risposte
 * (un masker nuovo ricomincia da 1). Chi guarda, Claude, chi si conosce e un
 * id che non è una persona restano com'erano; `null` resta `null`.
 */
export function personMasker(
  viewerId: string,
  // Revisione del lotto 2 (minor): chi ha già «chi si conosce» della risposta
  // lo passa, così non si ricalcola (una volta per risposta).
  known: ReadonlySet<string> = knownPeopleFor(viewerId),
): <T extends string | null | undefined>(id: T) => T {
  const people = new Set(PEOPLE.map((p) => p.id));
  const hidden = new Map<string, string>();
  return <T extends string | null | undefined>(id: T): T => {
    if (id === null || id === undefined) return id;
    if (id === viewerId || id === CLAUDE_ID || !people.has(id) || known.has(id)) return id;
    let placeholder = hidden.get(id);
    if (!placeholder) {
      placeholder = `hidden-${hidden.size + 1}`;
      hidden.set(id, placeholder);
    }
    return placeholder as T;
  };
}

/** Il campo è un segnaposto: sta in `hiddenId.ts` (senza import, lo usano le pagine). */
export { isHiddenId } from "./hiddenId";

type Masker = ReturnType<typeof personMasker>;

/**
 * Una task come la legge chi guarda (r.1414): assegnatario, chi l'ha creata,
 * chi la segue e chi l'ha fermata a mano passano dal masker della risposta.
 */
export function maskedTask(t: Task, mask: Masker): Task {
  const out = structuredClone(t);
  out.assigneeId = mask(t.assigneeId);
  out.createdById = mask(t.createdById);
  out.followerIds = t.followerIds.map(mask);
  if (out.manualStall) out.manualStall = { ...out.manualStall, byId: mask(out.manualStall.byId) };
  return out;
}

/** Una task ferma (revisione del lotto 2-3, 46): anche «ferma su chi» passa dal masker. */
export function maskedStalled(
  row: { task: Task; stall: Stall },
  mask: Masker,
): { task: Task; stall: Stall } {
  const task = maskedTask(row.task, mask);
  const reason = row.stall.reason;
  return {
    task,
    stall:
      reason.kind === "decision"
        ? { ...row.stall, reason: { ...reason, personId: mask(reason.personId) } }
        : row.stall,
  };
}
