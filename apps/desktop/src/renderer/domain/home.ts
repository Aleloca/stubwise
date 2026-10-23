import type {
  DepartmentHome,
  HomeBlockKind,
  HomeBlockRef,
  PersonalHome,
  Person,
} from "../data/types";

/** I blocchi che aprono ogni Home e non si nascondono. */
export const FIXED_BLOCKS: HomeBlockKind[] = ["decide", "myWeek"];

/** Due riferimenti sono lo stesso blocco: un `filter` solo con lo stesso filtro. */
export function sameBlock(a: HomeBlockRef, b: HomeBlockRef): boolean {
  return a.kind === b.kind && (a.kind !== "filter" || a.filterId === b.filterId);
}

function dedup(blocks: HomeBlockRef[]): HomeBlockRef[] {
  const out: HomeBlockRef[] = [];
  for (const block of blocks) {
    if (!out.some((b) => sameBlock(b, block))) out.push({ ...block });
  }
  return out;
}

/**
 * I fissi che mancano tornano in testa, nell'ordine di `FIXED_BLOCKS`: un
 * fisso mancante va subito dopo il fisso che lo precede (se c'è), altrimenti
 * in cima — così «Decide» resta prima di «My week» anche se ne manca uno.
 */
function withFixed(blocks: HomeBlockRef[]): HomeBlockRef[] {
  const out = [...blocks];
  FIXED_BLOCKS.forEach((kind, i) => {
    if (out.some((b) => b.kind === kind)) return;
    const before = i > 0 ? out.findIndex((b) => b.kind === FIXED_BLOCKS[i - 1]) : -1;
    out.splice(before + 1, 0, { kind });
  });
  return out;
}

/**
 * La Home di una persona. Senza Home personale: l'unione delle Home dei suoi
 * reparti, nell'ordine del primo reparto, i doppioni una volta sola. Con la
 * personale: i suoi blocchi. In entrambi i casi i blocchi fissi ci sono
 * sempre. `departmentChanged` = i reparti la cui Home è cambiata dopo
 * l'ultima volta che la persona (con Home personale) l'ha vista.
 */
export function resolveHome(
  person: Person,
  departmentHomes: DepartmentHome[],
  personal: PersonalHome | null,
): { blocks: HomeBlockRef[]; departmentChanged: string[] } {
  const mine = person.departmentIds.flatMap((id) => {
    const home = departmentHomes.find((h) => h.departmentId === id);
    return home ? [home] : [];
  });
  if (!personal) {
    return { blocks: withFixed(dedup(mine.flatMap((h) => h.blocks))), departmentChanged: [] };
  }
  const departmentChanged = mine
    .filter((h) => {
      const seen = personal.seenDepartmentUpdates[h.departmentId];
      return !seen || h.updatedAt > seen;
    })
    .map((h) => h.departmentId);
  return { blocks: withFixed(dedup(personal.blocks)), departmentChanged };
}
