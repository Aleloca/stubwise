import { visitSteps } from "../../domain/automations/fields";
import { copy, state, visibleProjectIds } from "../store";
import type { AutomationRun, ReasonCode, RunLogEntry } from "../types";
import { aiWaitingOf } from "./runner";
import {
  automationById,
  canSeeAutomation,
  canSeeRun,
  decidersOf,
  flowOf,
  runById,
  runCode,
} from "./visibility";

// Cosa di un'esecuzione vede chi guarda (R-J12, R-J13, R-J14, R-J16): un
// solo punto, `viewRun`, da cui passano tutte le letture (elenco,
// dettaglio, ricerca, Home, «Decide», sezione del progetto).

/**
 * I parametri di una motivazione oscurati: ogni valore diventa «…» (la
 * frase regge, il dato non esce). Regola generale, non per codice.
 */
const blankWhy = (why: ReasonCode | null | undefined): ReasonCode | null | undefined =>
  why?.params
    ? { code: why.code, params: Object.fromEntries(Object.keys(why.params).map((k) => [k, "…"])) }
    : why;

/**
 * R-G5 attraverso «Avvia un'altra automazione»: l'automazione che un passo
 * avvia, se `me` non la vede (`undefined` se il passo non ne avvia una, o
 * se la vede).
 */
function hiddenTarget(me: string, run: AutomationRun, e: RunLogEntry): string | undefined {
  if (e.kind !== "startAutomation") return undefined;
  let id: string | undefined;
  const flow = flowOf(run);
  if (flow)
    visitSteps(flow.steps, (s) => {
      if (s.id === e.stepId && s.kind === "startAutomation") id = s.automationId;
    });
  const target = id ? automationById(id) : undefined;
  return id && (!target || !canSeeAutomation(me, target)) ? id : undefined;
}

/** R-J12: un `progetto` (dati di una riga, anteprima) che chi guarda non vede diventa `""`. */
export function hideProject(o: Record<string, unknown>, visible: ReadonlySet<string>): void {
  if (typeof o.progetto === "string" && o.progetto !== "" && !visible.has(o.progetto))
    o.progetto = "";
}

/** Il progetto di una cosa creata da un passo, se è in un progetto. */
function projectOfEffect(kind: string, code: string): string | null {
  if (kind === "task") return state.tasks.find((t) => t.code === code)?.projectId ?? null;
  if (kind === "milestone") return state.milestones.find((m) => m.id === code)?.projectId ?? null;
  if (kind === "request") return state.requests.find((r) => r.code === code)?.projectId ?? null;
  return null;
}

/** L'esecuzione è partita da un'email in arrivo (della casella del proprietario). */
function startedByMail(run: AutomationRun): boolean {
  const t = automationById(run.automationId)?.versions.find((v) => v.n === run.version)?.flow
    .trigger;
  return t?.kind === "stubwise" && t.event === "mail_received";
}

/**
 * Se l'evento di un'esecuzione è un'email, di chi è (`ownerId`); `null` se
 * non lo è. «Avvia un'altra automazione» passa alla figlia l'evento della
 * madre così com'è: l'origine «da un'email» si eredita lungo la catena
 * (R-J13), e l'email è del proprietario della prima della catena.
 */
function mailOrigin(run: AutomationRun): { ownerId: string | null } | null {
  let cur: AutomationRun | undefined = run;
  while (cur.origin === "automation" && cur.parentRunId) {
    const parent = runById(cur.parentRunId);
    if (!parent) break;
    cur = parent;
  }
  return startedByMail(cur) ? { ownerId: automationById(cur.automationId)?.ownerId ?? null } : null;
}

/**
 * Un'esecuzione come la vede `me`.
 * - R-J12 (R-G5 dentro un'esecuzione): i progetti che non vede spariscono da
 *   `projectIds` e dai clienti risolti; nel registro e nell'anteprima un
 *   `progetto` invisibile diventa `""`, e una cosa creata in un progetto
 *   invisibile resta col suo tipo ma `code: ""` (né id né codice).
 * - R-J13 (privacy della Posta): di un'esecuzione partita da un'email (anche
 *   figlia di una partita da un'email, `mailOrigin`) solo il proprietario
 *   dell'email vede mittente, oggetto e testo; gli altri leggono un evento
 *   vuoto con `mailHidden` (la pagina lo dice, tradotto), il titolo col solo
 *   nome, e le righe del registro senza dati (nessuna eco dell'email:
 *   ingressi, uscite, motivazioni, parametri dei motivi, variabili). Chi
 *   deve approvare vede l'anteprima del passo.
 * - R-G5 attraverso «Avvia un'altra automazione»: un'esecuzione figlia che
 *   non vede resta senza codice, e il bersaglio senza id né nome.
 */
export function viewRun(me: string, run: AutomationRun): AutomationRun {
  const v = copy(run);
  // Ferma per un blocco d'istanza (area 9b): il blocco di adesso.
  const waiting = aiWaitingOf(run.id);
  if (waiting) v.aiWaiting = copy(waiting);
  const visible = visibleProjectIds(me);
  const scrub = (o: Record<string, unknown>) => hideProject(o, visible);
  v.projectIds = v.projectIds.filter((p) => visible.has(p));
  if (v.projects)
    v.projects = Object.fromEntries(Object.entries(v.projects).filter(([, p]) => visible.has(p)));
  for (const e of v.log) {
    scrub(e.input);
    scrub(e.output);
    e.effects = e.effects.map((x) => {
      if (x.kind === "run") {
        // Un'esecuzione avviata che non vedo: né codice né link (R-G5).
        const child = state.automationRuns.find((r) => runCode(r) === x.code);
        return child && !canSeeRun(me, child) ? { kind: x.kind, code: "" } : x;
      }
      const p = projectOfEffect(x.kind, x.code);
      return p !== null && !visible.has(p) ? { kind: x.kind, code: "" } : x;
    });
    // Il bersaglio di «Avvia» che non vedo: niente id nei dati, niente nome nel motivo.
    if (hiddenTarget(me, run, e) !== undefined) {
      if (typeof e.input.automazione === "string") e.input.automazione = "";
      e.why = blankWhy(e.why);
      e.reason = null;
    }
  }
  if (v.pending) {
    scrub(v.pending.preview);
    const at = [...v.log].reverse().find((e) => e.path === v.cursor);
    if (
      at &&
      hiddenTarget(me, run, at) !== undefined &&
      typeof v.pending.preview.automazione === "string"
    )
      v.pending.preview.automazione = "";
    // Chi decide si legge adesso (come `decide`): il proprietario può essere cambiato.
    v.pending.approverIds = decidersOf(run);
  }
  const a = automationById(run.automationId);
  if (a?.ownerId !== me) {
    // R-J14: l'anteprima di chi decide resta intera — separata prima di
    // nascondere, perché può condividere oggetti col registro.
    if (v.pending) v.pending.preview = copy(v.pending.preview);
    hideReplies(v, !decidersOf(run).includes(me));
  }
  const mail = mailOrigin(run);
  if (mail && mail.ownerId !== me) {
    // Il titolo è il solo nome; la pagina dice, tradotto, che l'email è nascosta (`mailHidden`).
    const hidden = { email: { mittente: "", oggetto: "", testo: "" } };
    v.event = hidden;
    v.title = a?.name ?? "";
    v.mailHidden = true;
    v.vars = {};
    v.loops = {};
    for (const e of v.log) {
      if (e.kind === "trigger") e.output = copy(hidden);
      else {
        // Nessuna eco dell'email: dati, motivazioni (anche di Claude) e parametri dei motivi.
        e.input = {};
        e.output = {};
        e.reason = null;
        e.why = blankWhy(e.why);
      }
    }
    if (v.pending && !decidersOf(run).includes(me)) v.pending.preview = {};
  }
  return v;
}

/**
 * R-J16 (shape [A 21]): la risposta del cliente sta nella casella del
 * proprietario, e il suo testo lo vede solo lui — su OGNI esecuzione, non
 * solo su quelle partite da un'email. Per gli altri ogni testo che la
 * contiene diventa `""`: l'uscita dell'attesa, gli ingressi di chi la legge
 * (Claude, condizioni, ripetizioni), le variabili, i campi di Claude che la
 * ripetono; la riga lo dice con `replyHidden`. L'anteprima di chi deve
 * approvare resta intera (R-J14).
 */
function hideReplies(v: AutomationRun, preview: boolean): void {
  const replies = new Set<string>();
  const add = (t: unknown) => {
    if (typeof t === "string" && t.trim()) replies.add(t);
  };
  for (const e of v.log) if (e.kind === "wait") add(e.output["risposta.testo"]);
  add(v.vars["risposta.testo"]);
  if (replies.size === 0) return;
  const echoes = (s: string) => [...replies].some((r) => s.includes(r));
  const hide = (o: unknown): boolean => {
    if (!o || typeof o !== "object") return false;
    let hit = false;
    const rec = o as Record<string, unknown>;
    for (const [k, val] of Object.entries(rec)) {
      if (typeof val === "string" && echoes(val)) {
        rec[k] = "";
        hit = true;
      } else if (val && typeof val === "object" && hide(val)) hit = true;
    }
    return hit;
  };
  for (const e of v.log) {
    const a = hide(e.input);
    const b = hide(e.output);
    if (a || b) e.replyHidden = true;
  }
  hide(v.vars);
  if (v.loops) hide(v.loops);
  if (preview && v.pending) hide(v.pending.preview);
}
