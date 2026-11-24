import { projects, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";

/**
 * Lotto 8, voce 3: i CONTESTI di una conversazione con Claude (le pagine da
 * cui è stata aperta), accumulati al più {@link CLAUDE_CONTEXTS_MAX}, l'ultimo
 * primario. Qui, condivisi fra server (la vista, gli eventi, la scrittura) e
 * worker (il prompt): le regole del gruppo e il progetto di ciascuno, su cui
 * si decide la visibilità («un contesto che chi guarda non vede non esce»,
 * r.1414 del registro). Il progetto di un contesto: l'id per un `project`,
 * il prefisso del codice (`AUD-12`, `AUD-R4`) per gli altri.
 */

export interface ClaudeContextRef {
  kind: string;
  id: string;
}

export const CLAUDE_CONTEXTS_MAX = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un codice con un progetto: task `AUD-12`, richiesta `AUD-R4`, automazione `AUD-A3`, supporto `AUD-S4`. */
const CODE = /^([A-Z][A-Z0-9]{1,9})-[A-Z]?\d+$/;

const same = (a: ClaudeContextRef, b: ClaudeContextRef) => a.kind === b.kind && a.id === b.id;

/** Senza doppioni (vale l'ULTIMA comparsa: è la più recente), nell'ordine. */
export function dedupeContexts(list: readonly ClaudeContextRef[]): ClaudeContextRef[] {
  return list.filter((c, i) => !list.slice(i + 1).some((d) => same(c, d)));
}

/** Il vecchio `{ context }`: AGGIUNGE in fondo, toglie il doppione e il più vecchio oltre il tetto. */
export function appendContext(group: readonly ClaudeContextRef[], context: ClaudeContextRef): ClaudeContextRef[] {
  return dedupeContexts([...group, context]).slice(-CLAUDE_CONTEXTS_MAX);
}

/** Il progetto di ogni contesto (null se non ce n'è uno), con UNA query per i codici. */
export async function contextProjectIds(db: Pick<Db, "select">, list: readonly ClaudeContextRef[]): Promise<(string | null)[]> {
  const ids = list.filter((c) => c.kind === "project" && UUID.test(c.id)).map((c) => c.id);
  const codes = list.flatMap((c) => {
    if (c.kind === "project") return [];
    const m = CODE.exec(c.id.toUpperCase());
    return m ? [m[1]!] : [];
  });
  const byId = new Set(ids.length > 0 ? (await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids))).map((r) => r.id) : []);
  const byCode = new Map(
    codes.length > 0 ? (await db.select({ id: projects.id, code: projects.code }).from(projects).where(inArray(projects.code, codes))).map((r) => [r.code, r.id] as const) : [],
  );
  return list.map((c) => {
    if (c.kind === "project") return byId.has(c.id) ? c.id : null;
    const m = CODE.exec(c.id.toUpperCase());
    return m ? (byCode.get(m[1]!) ?? null) : null;
  });
}

/**
 * I contesti che chi guarda può vedere: quelli il cui progetto è fra i suoi
 * (`sees`); gli altri si TOLGONO (non un segnaposto: un chip senza nome non
 * dice niente). Un contesto SENZA progetto (la propria posta `mail:`, una PR
 * `pr:`, una pagina d'impostazioni, o un codice di un progetto che non esiste
 * più) resta solo all'AUTORE, che l'ha aperto: a un lettore non esce mai.
 */
export async function visibleContexts(
  db: Pick<Db, "select">,
  list: readonly ClaudeContextRef[],
  sees: (projectId: string) => boolean | Promise<boolean>,
  opts: { isAuthor: boolean },
): Promise<ClaudeContextRef[]> {
  if (list.length === 0) return [];
  const projectIds = await contextProjectIds(db, list);
  const out: ClaudeContextRef[] = [];
  for (const [i, c] of list.entries()) {
    const pid = projectIds[i];
    if (pid ? await sees(pid) : opts.isAuthor) out.push({ kind: c.kind, id: c.id });
  }
  return out;
}
