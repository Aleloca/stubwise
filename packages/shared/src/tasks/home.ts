/**
 * La Home a blocchi (integrazione area 2, fetta 3): le regole PURE, spostate
 * da `apps/desktop/src/renderer/domain/home.ts`. Una regola, un posto: le
 * usano il finto, il server (che risponde con la Home già risolta) e l'app.
 * Le funzioni sono generiche sul tipo del blocco, così il prototipo ci passa
 * il suo `HomeBlockRef` (kind chiuso) e il server il suo (kind aperto).
 */

/** I tipi di blocco che l'app conosce oggi. Un kind ignoto passa e il client lo ignora. */
export const HOME_BLOCK_KINDS = [
  "decide",
  "myWeek",
  "myTasks",
  "claudeForMe",
  "stalledInMyProjects",
  "newRequests",
  "upcomingMilestones",
  "upcomingEvents",
  "importantMail",
  "automations",
  "releases",
  "waitingCustomers",
  "filter",
] as const;

export interface HomeBlockLike {
  kind: string;
  filterId?: string;
}

export interface DepartmentHomeData<B extends HomeBlockLike = HomeBlockLike> {
  departmentId: string;
  blocks: B[];
  updatedAt: string;
}

export interface PersonalHomeData<B extends HomeBlockLike = HomeBlockLike> {
  /** Di chi è (il prototipo lo tiene nella riga; il server lo sa dalla sessione). */
  personId?: string;
  blocks: B[];
  /** Per reparto, l'`updatedAt` della sua Home l'ultima volta che la persona l'ha vista. */
  seenDepartmentUpdates: Record<string, string>;
}

/** I blocchi che aprono ogni Home e non si nascondono. */
export const FIXED_BLOCKS = ["decide", "myWeek"] as const;

/** Due riferimenti sono lo stesso blocco: un `filter` solo con lo stesso filtro. */
export function sameBlock(a: HomeBlockLike, b: HomeBlockLike): boolean {
  return a.kind === b.kind && (a.kind !== "filter" || a.filterId === b.filterId);
}

function dedup<B extends HomeBlockLike>(blocks: B[]): B[] {
  const out: B[] = [];
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
export function withFixed<B extends HomeBlockLike>(blocks: B[]): B[] {
  const out = [...blocks];
  FIXED_BLOCKS.forEach((kind, i) => {
    if (out.some((b) => b.kind === kind)) return;
    const before = i > 0 ? out.findIndex((b) => b.kind === FIXED_BLOCKS[i - 1]) : -1;
    out.splice(before + 1, 0, { kind } as B);
  });
  return out;
}

/** La forma in cui una Home si salva: doppioni via, fissi rimessi. */
export function normalizeBlocks<B extends HomeBlockLike>(blocks: B[]): B[] {
  return withFixed(dedup(blocks));
}

/**
 * La Home di una persona. Senza Home personale: l'unione delle Home dei suoi
 * reparti, nell'ordine del primo reparto, i doppioni una volta sola. Con la
 * personale: i suoi blocchi. In entrambi i casi i blocchi fissi ci sono
 * sempre. `departmentChanged` = i reparti la cui Home è cambiata dopo
 * l'ultima volta che la persona (con Home personale) l'ha vista.
 *
 * `extras`: i blocchi che spettano per permesso a chi non ha personalizzato
 * la Home (shape releases.md [R 22]): in coda, solo nella Home non personale.
 */
export function resolveHome<B extends HomeBlockLike>(
  person: { departmentIds: readonly string[] },
  departmentHomes: readonly DepartmentHomeData<B>[],
  personal: PersonalHomeData<B> | null,
  extras: readonly B["kind"][] = [],
): { blocks: B[]; departmentChanged: string[] } {
  const mine = person.departmentIds.flatMap((id) => {
    const home = departmentHomes.find((h) => h.departmentId === id);
    return home ? [home] : [];
  });
  if (!personal) {
    const blocks = [...mine.flatMap((h) => h.blocks), ...extras.map((kind) => ({ kind }) as B)];
    return { blocks: normalizeBlocks(blocks), departmentChanged: [] };
  }
  const departmentChanged = mine
    .filter((h) => {
      const seen = personal.seenDepartmentUpdates[h.departmentId];
      return !seen || h.updatedAt > seen;
    })
    .map((h) => h.departmentId);
  return { blocks: normalizeBlocks(personal.blocks), departmentChanged };
}

/**
 * «Vedi le novità»: i blocchi delle Home dei reparti cambiati che la Home di
 * chi guarda non ha ancora, nell'ordine dei reparti, una volta sola. Il client
 * toglie quelli che nella sua build non sono disponibili.
 */
export function departmentNovelties<B extends HomeBlockLike>(
  changed: readonly string[],
  departmentHomes: readonly DepartmentHomeData<B>[],
  current: readonly HomeBlockLike[],
): B[] {
  const found: B[] = [];
  for (const id of changed) {
    const home = departmentHomes.find((h) => h.departmentId === id);
    for (const b of home?.blocks ?? []) {
      if (current.some((x) => sameBlock(x, b)) || found.some((x) => sameBlock(x, b))) continue;
      found.push({ ...b });
    }
  }
  return found;
}
