import type { ChangeType } from "./types";

// Il registro dei tipi di voce del registro delle modifiche: codice, non
// stato, senza store né seme. `record.ts` lo ri-esporta (integrazione area
// 2, fetta 1: le regole di visibilità lo leggono anche nella build app).

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
        known.scope !== t.scope ||
        known.group !== t.group)
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
