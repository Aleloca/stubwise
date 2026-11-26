import { triggerFields, visitSteps } from "./fields.js";
import { STUBWISE_TRIGGER_FIELDS, WAIT_REPLY_FIELDS } from "./triggerFields.js";
import type { AutomationFlow, AutomationSource, Condition, Step } from "./types.js";

// I campi «tinti» (area 7, F3, F3-1 = a *(M)*): ciò che arriva da fuori lo
// scrive chiunque — un'email arrivata (F2-1: anche quelle che la Posta tiene
// fuori), la risposta di un cliente, l'evento di una sorgente esterna. Un
// passo di Claude che ne legge uno ha i suoi campi tinti, e la tinta passa a
// chi li legge dopo. Un passo che usa un campo tinto per scegliere A CHI o
// DOVE va l'effetto (il destinatario di un'email, la persona di un avviso o
// di una task, il cliente da cui si ricava il progetto) chiede SEMPRE
// l'approvazione: la regola delle classi («un'azione che tocca altri non è
// mai A»). Il costruttore la forza (`forceApprovalForUntrusted`) e
// `validateFlow` la ricontrolla (`untrusted_target`).

const keysOf = (fields: readonly { key: string }[]) => fields.map((f) => f.key);

/**
 * Review F4: `eventUntrusted` — l'evento di QUESTA esecuzione viene da fuori
 * per intero, qualunque sia l'inizio del flusso: è la figlia di «avvia
 * un'altra» quando la madre partiva da una sorgente, da un'email o da una
 * richiesta dal supporto (riceve il suo evento). Allora ogni campo
 * dell'inizio è un ingresso da fuori. Lo decide l'esecuzione (la colonna
 * `automation_runs.event_untrusted`), non il flusso.
 */
export interface TaintOptions {
  eventUntrusted?: boolean;
}

/**
 * L'inizio del flusso porta dati di fuori? (sorgente, email in arrivo, una
 * richiesta che può venire dal supporto salvo il filtro che la esclude). Lo
 * eredita la figlia di «avvia un'altra» (`eventUntrusted`).
 */
export function eventIsUntrusted(flow: AutomationFlow): boolean {
  const t = flow.trigger;
  if (t.kind === "source") return true;
  if (t.kind !== "stubwise") return false;
  if (t.event === "mail_received") return true;
  return (t.event === "request_created" || t.event === "request_converted") && !excludesSupport(t.filter);
}

/** I campi che arrivano da fuori, prima di ogni passo di Claude. */
function untrustedBase(flow: AutomationFlow, sources: AutomationSource[], opts: TaintOptions = {}): Set<string> {
  const base = new Set<string>(keysOf(WAIT_REPLY_FIELDS));
  if (opts.eventUntrusted) for (const k of keysOf(triggerFields(flow, sources))) base.add(k);
  const t = flow.trigger;
  if (t.kind === "stubwise" && t.event === "mail_received")
    for (const k of keysOf(STUBWISE_TRIGGER_FIELDS.mail_received)) base.add(k);
  // Review F3, I4 *(O, 46)*: una richiesta può venire dal widget di supporto
  // (`richiesta.dal_supporto`): allora titolo e descrizione li ha scritti un
  // cliente. La tinta si calcola sul flusso, prima dell'evento: è tinta salvo
  // un filtro dell'inizio che escluda le richieste dal supporto.
  if (t.kind === "stubwise" && (t.event === "request_created" || t.event === "request_converted") && !excludesSupport(t.filter))
    for (const k of ["richiesta.titolo", "richiesta.descrizione"]) base.add(k);
  if (t.kind === "source")
    for (const k of keysOf(sources.find((s) => s.id === t.sourceId)?.fields ?? [])) base.add(k);
  return base;
}

/** Il filtro dell'inizio esclude le richieste dal supporto (`richiesta.dal_supporto` è falso, in un «tutte»)? */
function excludesSupport(filter: Condition | undefined): boolean {
  if (!filter) return false;
  const leaf = (c: Condition) =>
    c.left !== undefined && "ref" in c.left && c.left.ref === "richiesta.dal_supporto" &&
    ((c.op === "is" && c.right !== undefined && "value" in c.right && c.right.value === false) ||
      (c.op === "is_not" && c.right !== undefined && "value" in c.right && c.right.value === true));
  return leaf(filter) || (filter.all ?? []).some(excludesSupport);
}

/** Una chiave è tinta se lo è lei o un suo prefisso (`cliente` → `cliente.email`). */
const isTainted = (keys: ReadonlySet<string>, key: string) =>
  keys.has(key) || [...keys].some((k) => key.startsWith(`${k}.`));

/** Tutti i campi tinti del flusso: gli ingressi da fuori e ciò che ne ricavano Claude e i «per ogni». */
export function taintedKeys(flow: AutomationFlow, sources: AutomationSource[], opts: TaintOptions = {}): Set<string> {
  return taint(flow, sources, opts).all;
}

/**
 * `all`: gli ingressi da fuori più ciò che ne ricava Claude; `derived`: solo
 * ciò che ne ricava Claude (i suoi campi, e gli elementi di un «per ogni» su
 * un suo elenco). F3-1 riguarda i campi di CLAUDE: rispondere al mittente o
 * scrivere al cliente di un evento è un dato dell'evento, già della F2.
 */
function taint(flow: AutomationFlow, sources: AutomationSource[], opts: TaintOptions = {}) {
  const keys = untrustedBase(flow, sources, opts);
  const derived = new Set<string>();
  // Fino al punto fisso: un passo di Claude può leggere ciò che un altro ricava.
  for (let changed = true; changed; ) {
    changed = false;
    visitSteps(flow.steps, (step) => {
      if (step.kind === "claude" && step.inputs.some((k) => isTainted(keys, k))) {
        for (const k of keysOf(step.fields))
          if (!derived.has(k)) {
            keys.add(k);
            derived.add(k);
            changed = true;
          }
      }
      if (step.kind === "forEach" && isTainted(derived, step.list) && !derived.has(step.as)) {
        keys.add(step.as);
        derived.add(step.as);
        changed = true;
      }
      // Review F3, M6: su un elenco GREZZO non fidato l'elemento è tinto (per chi
      // legge: R-J16, `reasonHidden`), ma non è deciso da Claude (F3-1 non scatta).
      if (step.kind === "forEach" && isTainted(keys, step.list) && !keys.has(step.as)) {
        keys.add(step.as);
        changed = true;
      }
    });
  }
  return { all: keys, derived };
}

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;
const templateUses = (keys: ReadonlySet<string>, template: string) =>
  [...template.matchAll(TOKEN)].some((m) => isTainted(keys, m[1]!));
const refOf = (target: unknown): string | null =>
  target && typeof target === "object" && "personRef" in target
    ? String((target as { personRef: unknown }).personRef)
    : null;

/** Il passo sceglie a chi o dove va l'effetto con un campo tinto? */
function picksWithTainted(step: Step, keys: ReadonlySet<string>): boolean {
  const ref = (key: string | null) => key !== null && isTainted(keys, key);
  switch (step.kind) {
    case "sendEmail":
      return templateUses(keys, step.to);
    case "notify":
      return ref(refOf(step.who));
    case "createTask":
      return (
        ref(refOf(step.assignee)) ||
        (step.project.mode === "from_client" && ref(step.project.clientRef))
      );
    case "createMilestone":
    case "createRequest":
      return step.project.mode === "from_client" && ref(step.project.clientRef);
    default:
      return false;
  }
}

/** I passi che scelgono a chi o dove con un campo tinto, col loro percorso. */
export function untrustedTargets(
  flow: AutomationFlow,
  sources: AutomationSource[],
  opts: TaintOptions = {},
): { stepId: string; path: string; approved: boolean }[] {
  const keys = taint(flow, sources, opts).derived;
  const out: { stepId: string; path: string; approved: boolean }[] = [];
  visitSteps(flow.steps, (step, path) => {
    if (picksWithTainted(step, keys))
      out.push({
        stepId: step.id,
        path,
        approved: "approval" in step && step.approval.mode === "ask",
      });
  });
  return out;
}

/**
 * Il flusso con «chiede al proprietario» su ogni passo che sceglie con un
 * campo tinto e non chiedeva già; lo stesso oggetto se non c'è niente da
 * forzare (il costruttore non salva per niente).
 */
export function forceApprovalForUntrusted(
  flow: AutomationFlow,
  sources: AutomationSource[],
  opts: TaintOptions = {},
): AutomationFlow {
  const toForce = new Set(
    untrustedTargets(flow, sources, opts)
      .filter((t) => !t.approved)
      .map((t) => t.stepId),
  );
  if (toForce.size === 0) return flow;
  const fix = (steps: Step[]): Step[] =>
    steps.map((step) => {
      let s = step;
      if (toForce.has(s.id) && "approval" in s)
        s = { ...s, approval: { mode: "ask", who: { owner: true } } } as Step;
      return withChildren(s, fix);
    });
  return { ...flow, steps: fix(flow.steps) };
}

/** Lo stesso passo coi figli rifatti (rami, giri, ripetizioni). */
function withChildren(step: Step, fix: (steps: Step[]) => Step[]): Step {
  switch (step.kind) {
    case "condition":
      return { ...step, then: fix(step.then), else: fix(step.else) };
    case "forEach":
      return { ...step, steps: fix(step.steps) };
    case "repeatUntil":
      return { ...step, steps: fix(step.steps), onLimit: fix(step.onLimit) };
    case "claude":
      return {
        ...step,
        branches: Object.fromEntries(Object.entries(step.branches).map(([k, v]) => [k, fix(v)])),
      };
    default:
      return step;
  }
}
