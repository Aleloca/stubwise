import { currentViaClient } from "../mcp/via-client.js";
import { maskUrlCredentials } from "./url-credentials.js";
import { changeLog, type Db } from "@stubwise/db";
import { sql } from "drizzle-orm";
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

/** L'oggetto «persona» di una voce: l'email di ALLORA come etichetta. */
export const personObject = (user: { id: string; email: string }) => ({ type: "person", id: user.id, label: user.email });

/** Scrive una voce del registro e ne restituisce l'id (area 10, F5: la card `member.added` lo porta). */
export async function recordChange(tx: Tx | Db, entry: ChangeInput): Promise<string> {
  const type = changeLogTypeOf(entry.type);
  if (!type) throw new Error(`tipo del registro sconosciuto: ${entry.type}`);
  if ((type.scope === "project") !== (entry.projectId !== null)) {
    throw new Error(`${entry.type}: una voce ${type.scope === "project" ? "di progetto vuole" : "d'istanza non vuole"} un projectId`);
  }
  const data = CHANGE_DATA_SCHEMAS[entry.type]!.parse(scrubLogData(entry.data));
  const actor = entry.actor;
  const [row] = await tx.insert(changeLog).values({
    // L'istante dell'INSERIMENTO, non l'inizio della transazione (`now()`): una
    // scrittura a mano iniziata prima di un'azione di Claude ma arrivata dopo
    // ha così un `at` dopo il suo `stamp`, e «Annulla» la vede (registro, area 9).
    at: sql`clock_timestamp()`,
    actorUserId: actor === "system" ? null : actor.id,
    actorEmail: actor === "system" ? "system" : actor.email,
    actorKind: actor === "system" ? "system" : actor.isAgent ? "agent" : "user",
    type: entry.type,
    projectId: entry.projectId,
    subjectKind: data.object.type,
    subjectId: data.object.id,
    data,
    // D4 della parità MCP: «via Claude Code» anche fuori da una transazione (altrimenti lo dà il DEFAULT).
    ...(currentViaClient() ? { viaClient: currentViaClient() } : {}),
  }).returning({ id: changeLog.id });
  return row!.id;
}

/**
 * Revisione del lotto 5 della parità MCP (I1): il controllo di sorgente qui
 * sotto vede solo le chiavi scritte DENTRO la chiamata, non quelle di un
 * helper che costruisce il prima/dopo (`fields(w)` → `changedFields`). Qui,
 * a runtime e in UN posto: una chiave dall'aria segreta nel prima, nel dopo o
 * nei params è un errore di programmazione (lancia); le credenziali dentro un
 * URL (`user:pass@`) si mascherano in `user:***@`, perché un URL dato da una
 * persona può portarle senza che lo scrittore lo sappia.
 */
function scrubLogData(data: ChangeInput["data"]): ChangeInput["data"] {
  const json = (text: string | null | undefined): string | null | undefined => {
    if (typeof text !== "string") return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return maskUrlCredentials(text);
    }
    return JSON.stringify(scrubValue(parsed));
  };
  return {
    ...data,
    ...(data.before !== undefined ? { before: json(data.before) } : {}),
    ...(data.after !== undefined ? { after: json(data.after) } : {}),
    ...(data.params !== undefined ? { params: scrubValue(data.params) as ChangeData["params"] } : {}),
  };
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const bad = keys.filter((k) => isSecretLogKey(k));
    if (bad.length > 0) throw new Error(`registro delle modifiche: un campo dall'aria di segreto (${bad.join(", ")}); per un segreto si scrive solo «sostituito»`);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

const isSecretLogKey = (key: string) => !ALLOWED_KEY_NAMES.has(key) && /secret|token|password|key|dsn/i.test(key);


/**
 * Le chiavi PROIBITE dentro le chiamate a `recordChange` di un sorgente: un
 * nome che contiene `secret`, `token`, `password` o `key` (eccetto
 * `ALLOWED_KEY_NAMES`). Per un segreto si scrive solo «sostituito». Lo usa il
 * test di sorgente sugli scrittori.
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
    found.push(...forbiddenKeysIn(source.slice(at, end + 1)));
    at = source.indexOf("recordChange(", end);
  }
  return found;
}

/**
 * Le eccezioni DICHIARATE, che non sono segreti: le ultime 4 cifre di una
 * chiave, e l'id della chiave d'accesso S3 (il nome dell'utente S3, la chiave
 * del campo `storage.changed` nel prototipo; il secret ha la sua voce
 * «sostituito»). Una nuova eccezione si aggiunge qui, mai aggirando il test.
 */
const ALLOWED_KEY_NAMES: ReadonlySet<string> = new Set(["keyLast4", "accessKeyId"]);

/** Le chiavi proibite in un pezzo di sorgente qualunque (un helper che costruisce `data`). */
export function forbiddenKeysIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
    const key = m[1]!;
    if (!ALLOWED_KEY_NAMES.has(key) && /secret|token|password|key/i.test(key)) found.push(key);
  }
  return found;
}

/** Il valore di un campo di una voce `fields` (area 9, F3): com'è dato da una persona, un booleano, una lista di id. */
export type ChangeFieldValue = string | boolean | string[] | null;

/**
 * Il prima e dopo di una voce `fields`, con la regola del prototipo
 * (`settingValues.ts`, `changedFields`): i SOLI campi che cambiano, in JSON;
 * `null` se non cambia niente (e allora non si scrive nessuna voce). Le liste
 * si confrontano nell'ordine dato: chi scrive le passa già ordinate.
 */
export function changedFields(
  before: Record<string, ChangeFieldValue>,
  after: Record<string, ChangeFieldValue>,
): { before: string; after: string } | null {
  const same = (a: ChangeFieldValue | undefined, b: ChangeFieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const keys = Object.keys(after).filter((k) => !same(before[k], after[k]));
  if (keys.length === 0) return null;
  const pick = (src: Record<string, ChangeFieldValue>) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, src[k] ?? null])));
  return { before: pick(before), after: pick(after) };
}

/** Un importo come valore stabile (Ruling T3): il numero in stringa (`"600"`, `"12.5"`), `null` = nessun budget. */
export const stableAmount = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(Number(value));
