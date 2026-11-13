import { evaluate, lookup } from "@stubwise/shared";
import type { Automation, AutomationTrigger, Condition, FilterCheck, ReasonCode } from "../../data/types";

// Le regole pure delle esecuzioni che servono anche alla prova (area 7, R3):
// stavano nei moduli del prototipo legati allo store (`runWrites`, `runView`,
// `sources`, `runner`, `visibility`), che le ri-esportano da qui. Spostate
// senza cambiarle, perché la prova della build app le usi senza il seme.

/** I campi che chi approva può correggere, per tipo di passo. */
const EDITABLE: Partial<Record<string, string[]>> = {
  createTask: ["titolo", "descrizione"],
  createMilestone: ["nome"],
  createRequest: ["titolo", "descrizione"],
  sendEmail: ["to", "subject", "body"],
  notify: ["testo"],
};

/** Le correzioni di un'approvazione, per il tipo del passo: `invalid: edited` se non ammesse (anche nella prova). */
export function checkEdited(kind: string | undefined, edited: Record<string, string>): void {
  const allowed = EDITABLE[kind ?? ""] ?? [];
  for (const [k, v] of Object.entries(edited)) {
    if (!allowed.includes(k) || typeof v !== "string") throw new Error("invalid: edited");
  }
}

/** R-J12: un `progetto` (dati di una riga, anteprima) che chi guarda non vede diventa `""`. */
export function hideProject(o: Record<string, unknown>, visible: ReadonlySet<string>): void {
  if (typeof o.progetto === "string" && o.progetto !== "" && !visible.has(o.progetto))
    o.progetto = "";
}

/** I confronti di una condizione, anche dentro i gruppi. */
export const leavesOf = (c: Condition): Condition[] =>
  c.all || c.any ? [...(c.all ?? []), ...(c.any ?? [])].flatMap(leavesOf) : [c];

/**
 * Il filtro dell'inizio vale per l'evento? Una regola sola: la usano l'avvio
 * vero (`startsOn`) e la prova (D3, area 10b), così non possono divergere.
 */
export function passesStartFilter(t: AutomationTrigger, payload: Record<string, unknown>): boolean {
  return t.kind !== "stubwise" || !t.filter || evaluate(t.filter, (key) => lookup(payload, key));
}

/**
 * L'esito di ogni confronto del filtro dell'inizio sull'evento, col valore
 * letto (D3): la prova lo mostra, la pagina non lo ricalcola.
 */
export function startFilterChecks(
  t: AutomationTrigger,
  payload: Record<string, unknown>,
): FilterCheck[] {
  if (t.kind !== "stubwise" || !t.filter) return [];
  const read = (key: string) => lookup(payload, key);
  return leavesOf(t.filter).map((condition) => ({
    condition: structuredClone(condition),
    value: condition.left && "ref" in condition.left ? (read(condition.left.ref) ?? null) : null,
    matches: evaluate(condition, read),
  }));
}

/** La motivazione di `no_approver` (R-J11), anche nella prova. */
export const NO_APPROVER_WHY: ReasonCode = { code: "noApprover" };
export const NO_APPROVER_REASON =
  "Nessuno può approvare questo passo: chi è indicato non c'è, o non vede il progetto. Va cambiato chi approva, poi si può riprovare.";

/** Il progetto di un passo da approvare, dalla sua anteprima: quello risolto, o quello dell'automazione. */
export function approvalProjectOf(preview: Record<string, unknown>, a: Automation): string | null {
  return typeof preview.progetto === "string" ? preview.progetto : a.projectId;
}
