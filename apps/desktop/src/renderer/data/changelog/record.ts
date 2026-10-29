import { newId, now, state } from "../store";
import type { ChangeEntry, ChangeInput, ChangeType } from "./types";

// La scrittura del registro: il registro dei tipi e `recordChange`. Il
// registro dei tipi è codice, non stato: `resetApi` non lo svuota.

const types = new Map<string, ChangeType>();

/**
 * Il punto d'estensione: ogni area dichiara i suoi tipi di voce (9a in
 * `admin/changeTypes.ts`, poi 9b e 9c). Registrare di nuovo lo stesso tipo
 * con la stessa forma non fa niente; con una forma diversa è un errore.
 */
export function registerChangeTypes(list: readonly ChangeType[]): void {
  for (const t of list) {
    const known = types.get(t.kind);
    if (
      known &&
      (known.templateKey !== t.templateKey ||
        known.readPermission !== t.readPermission ||
        known.scope !== t.scope)
    )
      throw new Error(`Change type already registered differently: ${t.kind}`);
    types.set(t.kind, Object.freeze({ ...t }));
  }
}

/** Il tipo registrato di una voce; `undefined` se nessuno l'ha dichiarato. */
export function changeTypeOf(kind: string): ChangeType | undefined {
  return types.get(kind);
}

/** I tipi registrati (per il filtro «Type» del registro). */
export function changeTypes(): ChangeType[] {
  return [...types.values()];
}

/**
 * Scrive una voce. Si chiama DENTRO la scrittura, solo a scrittura riuscita
 * (dopo il cancello e i controlli, insieme al cambio di stato). Un tipo non
 * registrato, o una voce che non rispetta il livello del tipo, lancia: è un
 * difetto di chi scrive, non un input sbagliato.
 */
export function recordChange(input: ChangeInput): void {
  const type = types.get(input.kind);
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
  };
  // Solo in aggiunta: una voce non si modifica né si cancella.
  state.changelog.push(Object.freeze(entry));
}
