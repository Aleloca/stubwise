import type { DataField, FieldType } from "./types.js";

/**
 * I CAMPI DI UNA SORGENTE (area 7, F4, C-F4-2): dall'esempio incollato da chi
 * gestisce l'integrazione ai campi (`deriveFields`), il controllo di un
 * evento in arrivo contro quei campi (`checkEventFields`, il 422 di F4-5) e
 * la chiave del cliente della tabella cliente → progetto (`clientKeyOf`).
 * Una regola sola per prova, server e prototipo: due copie rifiuterebbero
 * eventi diversi.
 *
 * L'evento di un webhook è NON fidato: `checkEventFields` restituisce la sola
 * PROIEZIONE sui campi dichiarati, così le chiavi in più del corpo non entrano
 * nei dati dei passi. Un campo assente o `null` non è un tipo sbagliato: un
 * CRM può omettere un campo facoltativo, e un passo che lo usa lo trova vuoto.
 */

/** Profondità massima dei campi (`a.b.c…`): oltre, un oggetto non diventa campi. */
export const FIELDS_MAX_DEPTH = 8;
/** Numero massimo di campi (contando quelli dentro gli elenchi). */
export const FIELDS_MAX = 200;

/**
 * Le chiavi che non diventano MAI un campo né un percorso (review F4, I2): il
 * corpo di un webhook è pubblico, e `{"__proto__": {…}}` in un JSON parsato è
 * una proprietà propria che, seguita come percorso, scriverebbe su
 * `Object.prototype` dell'intero processo.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const forbiddenPath = (path: readonly string[]) => path.some((p) => FORBIDDEN_KEYS.has(p));

/** Un valore (oggetto o elenco, a qualunque profondità) contiene una chiave proibita? */
export function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  return Object.keys(value).some((k) => FORBIDDEN_KEYS.has(k) || hasForbiddenKey((value as Record<string, unknown>)[k], depth + 1));
}

/** `customer.email` → «Customer email»; `importoTotale` → «Importo totale». */
export function labelFromKey(key: string): string {
  const words = key
    .split(/[._-]+/)
    .flatMap((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function typeOf(v: unknown): FieldType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string" && EMAIL.test(v)) return "email";
  if (typeof v === "string" && DATE.test(v)) return "date";
  return "text";
}

/** I campi di un esempio: gli oggetti si appiattiscono (`cliente.nome`), gli elenchi di oggetti portano i loro. */
export function deriveFields(obj: Record<string, unknown>): DataField[] {
  const budget = { left: FIELDS_MAX };
  return derive(obj, "", 1, budget);
}

function derive(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  budget: { left: number },
): DataField[] {
  const out: DataField[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (budget.left <= 0) break;
    if (FORBIDDEN_KEYS.has(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) {
      if (depth < FIELDS_MAX_DEPTH) out.push(...derive(v, key, depth + 1, budget));
    } else if (Array.isArray(v)) {
      budget.left--;
      const first = v[0];
      const of = isObject(first) && depth < FIELDS_MAX_DEPTH ? derive(first, "", depth + 1, budget) : null;
      out.push({ key, label: labelFromKey(key), type: "list", ...(of ? { of } : {}) });
    } else {
      budget.left--;
      out.push({ key, label: labelFromKey(key), type: typeOf(v) });
    }
  }
  return out;
}

/** Le chiavi (anche quelle dentro gli elenchi, `prodotti.nome`) di un insieme di campi. */
export function fieldKeys(fields: DataField[], prefix = ""): string[] {
  return fields.flatMap((f) => [prefix + f.key, ...(f.of ? fieldKeys(f.of, `${prefix}${f.key}.`) : [])]);
}

/** Tiene etichetta e tipo scelti a mano per le chiavi che restano. */
export function mergeFields(next: DataField[], old: DataField[]): DataField[] {
  return next.map((f) => {
    const was = old.find((o) => o.key === f.key);
    if (!was) return f;
    return {
      ...f,
      label: was.label,
      type: was.type,
      ...(f.of ? { of: mergeFields(f.of, was.of ?? []) } : {}),
    };
  });
}

/**
 * La chiave del cliente nella tabella cliente → progetto: senza spazi e in
 * minuscolo. Va applicata sia alla SCRITTURA della riga sia alla RICERCA:
 * altrimenti `Acme.it` non trova la riga `acme.it`.
 */
export function clientKeyOf(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toLowerCase();
}

export type EventCheck =
  | { ok: true; event: Record<string, unknown> }
  /** `key`: il campo col tipo sbagliato (`prodotti.qta` dentro un elenco). */
  | { ok: false; key: string; expected: FieldType };

function fits(type: FieldType, v: unknown): boolean {
  switch (type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "date":
      return typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
    case "email":
      return typeof v === "string" && EMAIL.test(v);
    case "list":
      return Array.isArray(v);
    // text, person, file: un testo.
    default:
      return typeof v === "string";
  }
}

type Found = { state: "absent" } | { state: "value"; value: unknown } | { state: "bad_shape" };

/** Il valore a un percorso: assente (o null), presente, o sotto un antenato che non è un oggetto. */
function lookup(obj: Record<string, unknown>, path: string[]): Found {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || cur === undefined) return { state: "absent" };
    if (!isObject(cur)) return { state: "bad_shape" };
    cur = Object.hasOwn(cur, p) ? cur[p] : undefined;
  }
  return cur === null || cur === undefined ? { state: "absent" } : { state: "value", value: cur };
}

/** Scrive solo su proprietà PROPRIE e mai su una chiave proibita (chi chiama le ha già scartate). */
function put(target: Record<string, unknown>, path: string[], value: unknown): void {
  if (forbiddenPath(path)) return;
  let cur = target;
  for (const p of path.slice(0, -1)) {
    if (!Object.hasOwn(cur, p) || !isObject(cur[p])) Object.defineProperty(cur, p, { value: {}, enumerable: true, writable: true, configurable: true });
    cur = cur[p] as Record<string, unknown>;
  }
  Object.defineProperty(cur, path.at(-1)!, { value, enumerable: true, writable: true, configurable: true });
}

/** Controlla un evento contro i campi della sorgente e ne restituisce la proiezione. */
export function checkEventFields(payload: Record<string, unknown>, fields: DataField[]): EventCheck {
  return project(payload, fields, "");
}

function project(payload: Record<string, unknown>, fields: DataField[], prefix: string): EventCheck {
  const event: Record<string, unknown> = {};
  for (const f of fields) {
    const path = f.key.split(".");
    // Un campo su una chiave proibita non si legge né si scrive (review F4, I2).
    if (forbiddenPath(path)) continue;
    const found = lookup(payload, path);
    if (found.state === "absent") continue;
    if (found.state === "bad_shape" || !fits(f.type, found.value))
      return { ok: false, key: prefix + f.key, expected: f.type };
    const value = found.value;
    if (f.type !== "list") {
      put(event, path, value);
      continue;
    }
    const items = value as unknown[];
    if (f.of && f.of.length > 0) {
      const out: Record<string, unknown>[] = [];
      for (const item of items) {
        if (!isObject(item)) return { ok: false, key: prefix + f.key, expected: "list" };
        const sub = project(item, f.of, `${prefix}${f.key}.`);
        if (!sub.ok) return sub;
        out.push(sub.event);
      }
      put(event, path, out);
    } else {
      // Un elenco senza campi dichiarati: solo i valori semplici.
      put(event, path, items.filter((x) => x === null || typeof x !== "object"));
    }
  }
  return { ok: true, event };
}
