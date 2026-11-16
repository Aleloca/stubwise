import { changeLog, type Db } from "@stubwise/db";
import { CHANGE_DATA_SCHEMAS, changeLogTypeOf, type ChangeData, type ChangeLogKind } from "@stubwise/shared";

/**
 * Area 9, F2 (D-3, D-4; docs/invariants/change-log.md): lo SCRITTORE del
 * registro delle modifiche, in UN posto.
 *
 * Si chiama SEMPRE col `tx` della modifica: la voce nasce o non nasce con lei.
 * Nessun `try/catch` — un errore del DB fa fallire la modifica, ed è voluto —
 * e un tipo sconosciuto o un `data` che non rispetta il suo schema sono errori
 * di programmazione: lanciano, e i test li vedono subito. I nomi in `data` si
 * fissano qui dal chiamante (il nome del ruolo di ALLORA); un segreto non
 * entra mai (un test di sorgente lo verifica su ogni scrittore).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ChangeInput {
  type: ChangeLogKind;
  /** Chi ha agito (`email` fissata ora), o `"system"` (primo avvio, script). */
  actor: { id: string; email: string; isAgent?: boolean } | "system";
  /** `null` per le voci d'istanza. */
  projectId: string | null;
  data: { object: { type: string; id: string; label: string }; before?: string | null; after?: string | null; params?: ChangeData["params"] };
}

export async function recordChange(tx: Tx | Db, entry: ChangeInput): Promise<void> {
  const type = changeLogTypeOf(entry.type);
  if (!type) throw new Error(`tipo del registro sconosciuto: ${entry.type}`);
  if ((type.scope === "project") !== (entry.projectId !== null)) {
    throw new Error(`${entry.type}: una voce ${type.scope === "project" ? "di progetto vuole" : "d'istanza non vuole"} un projectId`);
  }
  const data = CHANGE_DATA_SCHEMAS[entry.type]!.parse(entry.data);
  const actor = entry.actor;
  await tx.insert(changeLog).values({
    actorUserId: actor === "system" ? null : actor.id,
    actorEmail: actor === "system" ? "system" : actor.email,
    actorKind: actor === "system" ? "system" : actor.isAgent ? "agent" : "user",
    type: entry.type,
    projectId: entry.projectId,
    subjectKind: data.object.type,
    subjectId: data.object.id,
    data,
  });
}

/**
 * Le chiavi PROIBITE dentro le chiamate a `recordChange` di un sorgente: un
 * nome che contiene `secret`, `token`, `password` o `key` (eccetto
 * `keyLast4`). Per un segreto si scrive solo «sostituito». Lo usa il test di
 * sorgente sugli scrittori.
 */
export function forbiddenChangeLogKeys(source: string): string[] {
  const found: string[] = [];
  let at = source.indexOf("recordChange(");
  while (at !== -1) {
    // L'argomento intero: fino alla parentesi che chiude la chiamata.
    let depth = 0;
    let end = at + "recordChange".length;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    const call = source.slice(at, end + 1);
    for (const m of call.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      const key = m[1]!;
      if (key !== "keyLast4" && /secret|token|password|key/i.test(key)) found.push(key);
    }
    at = source.indexOf("recordChange(", end);
  }
  return found;
}
