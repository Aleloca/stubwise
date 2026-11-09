import type { Condition, Operand } from "../../data/types";

// Le condizioni di un flusso: gruppi `all`/`any` e confronti semplici, niente
// espressioni libere. Pure: i dati arrivano da fuori.

/** Come si leggono i dati: variabili (anche annidate) o un risolutore. */
export type Vars = Record<string, unknown> | ((key: string) => unknown);

/**
 * Il valore di una chiave: prima la chiave piatta (le variabili scritte dai
 * passi, es. "analisi.prodotto"), poi il percorso puntato in un oggetto
 * annidato (l'evento, es. "cliente.nome" → `cliente.nome`).
 */
export function lookup(data: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(data, key)) return data[key];
  let cur: unknown = data;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const read = (vars: Vars, key: string) =>
  typeof vars === "function" ? vars(key) : lookup(vars, key);
const operand = (o: Operand | undefined, vars: Vars) =>
  o === undefined ? undefined : "ref" in o ? read(vars, o.ref) : o.value;

const norm = (s: string) => s.trim().toLowerCase();

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Uguaglianza tollerante: testo senza maiuscole e spazi, numero o booleano scritti come testo. */
function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    return !Number.isNaN(x) && x === y;
  }
  if (typeof a === "string" && typeof b === "string") return norm(a) === norm(b);
  return a === b;
}

function contains(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => same(x, b));
  if (typeof a === "string" && (typeof b === "string" || typeof b === "number")) {
    return norm(a).includes(norm(String(b)));
  }
  return false;
}

/** Confronto d'ordine: numeri, o date ISO come testo. Un dato assente non è né maggiore né minore. */
function order(a: unknown, b: unknown): number | null {
  if (isEmpty(a) || isEmpty(b)) return null;
  if (
    typeof a === "string" &&
    typeof b === "string" &&
    /^\d{4}-\d{2}-\d{2}/.test(a) &&
    /^\d{4}-\d{2}-\d{2}/.test(b)
  ) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x - y;
}

/**
 * Vera se tutti i gruppi e il confronto presenti sono veri: `all` vuoto è
 * vero, `any` vuoto è falso, un confronto incompleto è falso.
 */
export function evaluate(cond: Condition, vars: Vars): boolean {
  const groups = cond.all !== undefined || cond.any !== undefined;
  if (cond.all && !cond.all.every((c) => evaluate(c, vars))) return false;
  if (cond.any && !cond.any.some((c) => evaluate(c, vars))) return false;
  if (cond.op === undefined || cond.left === undefined) return groups && cond.left === undefined;
  const left = operand(cond.left, vars);
  const right = operand(cond.right, vars);
  switch (cond.op) {
    case "is":
      return same(left, right);
    case "is_not":
      return !same(left, right);
    case "contains":
      return contains(left, right);
    case "empty":
      return isEmpty(left);
    case "not_empty":
      return !isEmpty(left);
    case "gt": {
      const o = order(left, right);
      return o !== null && o > 0;
    }
    case "lt": {
      const o = order(left, right);
      return o !== null && o < 0;
    }
  }
}

/** Le chiavi citate da una condizione, in ordine e senza doppioni. */
export function conditionRefs(cond: Condition): string[] {
  const out: string[] = [];
  const visit = (c: Condition) => {
    for (const o of [c.left, c.right]) if (o && "ref" in o && !out.includes(o.ref)) out.push(o.ref);
    c.all?.forEach(visit);
    c.any?.forEach(visit);
  };
  visit(cond);
  return out;
}
