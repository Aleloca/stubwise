import { leavesOf, passesStartFilter } from "./runRules.js";
import type { AutomationFlow, Condition, DataField } from "./types.js";

/**
 * L'esempio «scritto da Claude» della prova di un'automazione (area 10, F2,
 * decisione 2a di 46; lotto 6, voce 5). Lo usa la prova quando il progetto non
 * ha un evento vero che passa (o che non passa) il filtro dell'inizio.
 *
 * ⚠️ NON LO SCRIVE UN MODELLO. «Example written by Claude» è solo l'ETICHETTA
 * del prototipo (la specifica): l'evento lo costruisce questa regola,
 * DETERMINISTICA e pura — un valore neutro per ogni campo dell'inizio (il
 * nome del campo per un testo, chi prova per una persona, il progetto
 * dell'automazione, la data di oggi), poi i confronti `is` e `contains` del
 * filtro soddisfatti; per un esempio che non deve passare, il primo confronto
 * rotto. Chiamare un modello qui costerebbe a ogni prova e romperebbe la
 * determinazione (lo stesso flusso deve dare lo stesso esempio, e il test lo
 * fissa): non «migliorarlo» così.
 *
 * Il risultato si verifica col filtro vero (`passesStartFilter`): dalla parte
 * sbagliata è `null` (un `any` che non sa rompere, un `gt`, nessun filtro per
 * «non passa»…), perché la prova direbbe ciò che il dato non dimostra.
 * Nessuna lettura: chi chiama passa solo ciò che chi prova può vedere.
 */

/** I valori noti dei dati che sono un elenco chiuso: il «diverso» di un esempio che non passa. */
export const WRITTEN_EXAMPLE_CLOSED_VALUES: Readonly<Record<string, readonly string[]>> = {
  "richiesta.urgenza": ["low", "medium", "high"],
};

export interface WrittenExampleContext {
  /** Chi prova: il valore di un campo persona. */
  viewerId: string;
  /** Il codice del progetto dell'automazione (null per una generale). */
  projectCode: string | null;
  /** La data di oggi, `YYYY-MM-DD`. */
  today: string;
}

/** Scrive `value` in `event` al percorso puntato di `key` («richiesta.urgenza»). */
function setAt(event: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = event;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

/** Un valore diverso da `value` per il dato `key`: un altro dell'elenco chiuso, il contrario, o vuoto. */
function otherThan(key: string, value: unknown, closed: Readonly<Record<string, readonly string[]>>): unknown {
  if (typeof value === "boolean") return !value;
  const list = closed[key];
  if (list) return list.find((v) => v !== value) ?? "";
  if (typeof value === "number") return value + 1;
  return "";
}

/** L'evento scritto (vedi sopra), o `null` se la regola non sa scriverlo dalla parte chiesta. */
export function writtenTrialEvent(
  flow: AutomationFlow,
  fields: readonly DataField[],
  ctx: WrittenExampleContext,
  passes: boolean,
  closed: Readonly<Record<string, readonly string[]>> = WRITTEN_EXAMPLE_CLOSED_VALUES,
): Record<string, unknown> | null {
  const event: Record<string, unknown> = {};
  for (const f of fields) {
    const value =
      f.key.endsWith(".progetto") && ctx.projectCode !== null
        ? ctx.projectCode
        : f.type === "boolean"
          ? false
          : f.type === "number"
            ? 0
            : f.type === "person"
              ? ctx.viewerId
              : f.type === "date"
                ? ctx.today
                : f.key.endsWith(".codice") || f.type === "email"
                  ? ""
                  : f.label;
    setAt(event, f.key, value);
  }
  const t = flow.trigger;
  if (t.kind === "stubwise" && t.filter) {
    const leaves = leavesOf(t.filter).filter(
      (c): c is Condition & { left: { ref: string }; right: { value: unknown } } =>
        (c.op === "is" || c.op === "contains") && c.left !== undefined && "ref" in c.left && c.right !== undefined && "value" in c.right,
    );
    for (const c of leaves) setAt(event, c.left.ref, c.right.value);
    const first = leaves[0];
    if (!passes && first) setAt(event, first.left.ref, otherThan(first.left.ref, first.right.value, closed));
  }
  return passesStartFilter(t, event) === passes ? event : null;
}
