import type {
  Approval,
  AutomationFlow,
  AutomationSource,
  Condition,
  DataField,
  FieldType,
  ProjectTarget,
  Step,
} from "../../data/types";
import {
  AUTOMATION_LIMITS,
  ancestorsAt,
  scopeAt,
  triggerFields,
  visitSteps,
  type Scope,
} from "./fields";

// La validazione di un flusso: pura, la usano il costruttore (errori sul
// passo), la pubblicazione (un flusso con errori non si accende) e la prova.
// I percorsi sono quelli di R-J5, coi giri al giro 0; "trigger" per l'inizio
// e il modello del titolo, "" per il flusso intero.

export type FlowIssueCode =
  | "incomplete"
  | "unknown_ref"
  | "type_mismatch"
  | "approver_cant_see"
  | "source_disconnected"
  | "limit";

export interface FlowIssue {
  path: string;
  code: FlowIssueCode;
  message: string;
}

export type ApprovalWho = Extract<Approval, { mode: "ask" }>["who"];

export interface ValidateContext {
  sources: AutomationSource[];
  /** Chi approva vede il progetto del passo? `projectId` null = non noto prima dell'evento. */
  canApprove(who: ApprovalWho, projectId: string | null): boolean;
  /** Il progetto dell'automazione: null = generale; assente = non controllare `own`. */
  projectId?: string | null;
}

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Le chiavi citate in un testo con `{{chiave}}`. */
export function templateRefs(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[1]!);
}

const blank = (s: string) => s.trim() === "";

export function validateFlow(flow: AutomationFlow, ctx: ValidateContext): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const add = (path: string, code: FlowIssueCode, message: string) =>
    issues.push({ path, code, message });

  // --- l'inizio e il titolo ---------------------------------------------------
  const t = flow.trigger;
  const startScope: Scope = {
    fields: new Map(triggerFields(flow, ctx.sources).map((f) => [f.key, f])),
    preceding: [],
  };
  if (t.kind === "source") {
    const source = ctx.sources.find((s) => s.id === t.sourceId);
    if (!source) add("trigger", "unknown_ref", "La sorgente dell'inizio non esiste più.");
    else if (source.status !== "connected") {
      add("trigger", "source_disconnected", `La sorgente «${source.name}» non è collegata.`);
    }
  }
  if (t.kind === "schedule" && blank(t.rule)) add("trigger", "incomplete", "Manca quando parte.");
  if (t.kind === "stubwise" && t.filter) checkCondition(t.filter, startScope, "trigger", add);
  if (blank(flow.titleTemplate)) add("trigger", "incomplete", "Manca il titolo delle esecuzioni.");
  checkRefs(flow.titleTemplate, startScope, "trigger", add);

  if (flow.steps.length === 0) add("", "incomplete", "Il flusso non ha passi.");

  // --- i passi ----------------------------------------------------------------
  const ids = new Set<string>();
  const asNames: string[] = [];
  visitSteps(flow.steps, (step) => {
    if (step.kind === "forEach" && !blank(step.as)) asNames.push(step.as);
  });
  visitSteps(flow.steps, (step, path) => {
    if (step.kind === "claude") checkClaudeKeys(step, path, flow, asNames, add);
    if (blank(step.id) || ids.has(step.id)) {
      add(path, "incomplete", "Il passo non ha un identificativo unico.");
    }
    ids.add(step.id);
    checkStep(step, path, scopeAt(flow, path, ctx.sources), ctx, add);
  });
  return issues;
}

type Add = (path: string, code: FlowIssueCode, message: string) => void;

/** Le chiavi che scrivono le attese e gli inizi: Claude non le può dichiarare. */
const RESERVED = ["risposta", "avvio"];
const under = (key: string, prefix: string) => key === prefix || key.startsWith(`${prefix}.`);

/**
 * Le chiavi dei campi di Claude: niente file (Claude non produce file), niente
 * chiavi riservate, niente collisioni con la variabile di un `forEach` (la
 * leggerebbe al posto del campo), e mai l'elenco del `forEach` che lo
 * contiene: gli elementi di un ciclo sono fissati all'ingresso.
 */
function checkClaudeKeys(
  step: Extract<Step, { kind: "claude" }>,
  path: string,
  flow: AutomationFlow,
  asNames: string[],
  add: Add,
): void {
  const all = step.fields.flatMap((f) => [f, ...(f.of ?? [])]);
  if (all.some((f) => f.type === "file")) {
    add(path, "type_mismatch", "Claude non può restituire un file.");
  }
  const lists = ancestorsAt(flow.steps, path).flatMap((s) =>
    s.kind === "forEach" ? [s.list] : [],
  );
  for (const { key } of step.fields) {
    if (blank(key)) continue;
    if (RESERVED.some((r) => under(key, r))) {
      add(path, "incomplete", `La chiave «${key}» è riservata.`);
    } else if (asNames.some((a) => under(key, a))) {
      add(path, "incomplete", `La chiave «${key}» si confonde con l'elemento di un «Per ogni».`);
    } else if (lists.includes(key)) {
      add(
        path,
        "incomplete",
        `«${key}» è l'elenco del «Per ogni» che contiene il passo: non si riscrive.`,
      );
    }
  }
}

function checkRefs(text: string, scope: Scope, path: string, add: Add): void {
  for (const ref of templateRefs(text)) {
    if (!scope.fields.has(ref))
      add(path, "unknown_ref", `Il dato «${ref}» non è disponibile in questo punto.`);
  }
}

function requireText(values: [string, string][], path: string, add: Add): boolean {
  const missing = values.find(([, v]) => blank(v));
  if (missing) add(path, "incomplete", `Manca ${missing[0]}.`);
  return !missing;
}

/** Il passo `kind` con id `id` è fra quelli già eseguiti nel ramo? */
const precedes = (scope: Scope, kind: Step["kind"], id: string) =>
  scope.preceding.some((s) => s.kind === kind && s.id === id);

function projectOf(target: ProjectTarget | null, ctx: ValidateContext): string | null {
  if (target?.mode === "fixed") return target.projectId;
  if (target?.mode === "from_client") return null;
  return ctx.projectId ?? null;
}

function checkTarget(
  target: ProjectTarget,
  scope: Scope,
  path: string,
  ctx: ValidateContext,
  add: Add,
) {
  if (target.mode === "own" && ctx.projectId === null) {
    add(
      path,
      "incomplete",
      "Un'automazione generale non ha un progetto suo: scegli un progetto fisso o dal cliente.",
    );
  }
  if (target.mode === "fixed" && blank(target.projectId))
    add(path, "incomplete", "Manca il progetto.");
  if (target.mode === "from_client" && !scope.fields.has(target.clientRef)) {
    add(
      path,
      "unknown_ref",
      `Il dato «${target.clientRef}» per trovare il cliente non è disponibile.`,
    );
  }
}

function checkApproval(
  approval: Approval,
  target: ProjectTarget | null,
  path: string,
  ctx: ValidateContext,
  add: Add,
) {
  if (approval.mode !== "ask") return;
  const who = approval.who;
  if (
    ("personId" in who && blank(who.personId)) ||
    ("projectRole" in who && blank(who.projectRole))
  ) {
    add(path, "incomplete", "Manca chi approva.");
    return;
  }
  if (!ctx.canApprove(who, projectOf(target, ctx))) {
    add(path, "approver_cant_see", "Chi deve approvare non vede il progetto del passo.");
  }
}

function checkStep(step: Step, path: string, scope: Scope, ctx: ValidateContext, add: Add): void {
  switch (step.kind) {
    case "createTask": {
      requireText([["il titolo", step.title]], path, add);
      checkRefs(step.title, scope, path, add);
      checkRefs(step.description, scope, path, add);
      const a = step.assignee;
      if (a && Object.values(a).some((v) => blank(v)))
        add(path, "incomplete", "Manca l'incaricato.");
      if (step.dueInDays !== null && step.dueInDays < 0)
        add(path, "incomplete", "La scadenza è nel passato.");
      if (step.milestoneRef !== null && !precedes(scope, "createMilestone", step.milestoneRef)) {
        add(path, "unknown_ref", "Il traguardo indicato non è creato da un passo precedente.");
      }
      checkTarget(step.project, scope, path, ctx, add);
      checkApproval(step.approval, step.project, path, ctx, add);
      return;
    }
    case "createMilestone":
      requireText([["il nome", step.name]], path, add);
      checkRefs(step.name, scope, path, add);
      checkTarget(step.project, scope, path, ctx, add);
      checkApproval(step.approval, step.project, path, ctx, add);
      return;
    case "createRequest":
      requireText([["il titolo", step.title]], path, add);
      checkRefs(step.title, scope, path, add);
      checkRefs(step.description, scope, path, add);
      checkTarget(step.project, scope, path, ctx, add);
      checkApproval(step.approval, step.project, path, ctx, add);
      return;
    case "sendEmail":
      requireText(
        [
          ["il destinatario", step.to],
          ["l'oggetto", step.subject],
          ["il testo", step.body],
        ],
        path,
        add,
      );
      for (const text of [step.to, step.subject, step.body]) checkRefs(text, scope, path, add);
      for (const ref of step.attachRefs) {
        const f = scope.fields.get(ref);
        if (!f) add(path, "unknown_ref", `L'allegato «${ref}» non è disponibile.`);
        else if (f.type !== "file") add(path, "type_mismatch", `«${f.label}» non è un file.`);
      }
      checkApproval(step.approval, null, path, ctx, add);
      return;
    case "notify": {
      requireText(
        [
          ["chi avvisare", step.personRef],
          ["il testo", step.text],
        ],
        path,
        add,
      );
      checkRefs(step.text, scope, path, add);
      // Un modello `{{…}}` o la chiave di un dato: mai un testo libero.
      if (step.personRef.includes("{{")) checkRefs(step.personRef, scope, path, add);
      else if (!blank(step.personRef)) {
        const f = scope.fields.get(step.personRef);
        if (!f)
          add(
            path,
            "unknown_ref",
            `Il dato «${step.personRef}» non è disponibile in questo punto.`,
          );
        else if (f.type !== "person") add(path, "type_mismatch", `«${f.label}» non è una persona.`);
      }
      checkApproval(step.approval, null, path, ctx, add);
      return;
    }
    case "startAutomation":
      requireText([["l'automazione da avviare", step.automationId]], path, add);
      checkApproval(step.approval, null, path, ctx, add);
      return;
    case "wait": {
      const w = step.for;
      if ("days" in w) {
        if (!(w.days > 0)) add(path, "incomplete", "L'attesa deve durare almeno un giorno.");
        return;
      }
      if (!(w.maxDays > 0)) add(path, "incomplete", "Manca il massimo di giorni dell'attesa.");
      if ("replyTo" in w && !precedes(scope, "sendEmail", w.replyTo)) {
        add(
          path,
          "unknown_ref",
          "L'email di cui aspettare la risposta non è mandata da un passo precedente.",
        );
      }
      if ("taskClosed" in w && !precedes(scope, "createTask", w.taskClosed)) {
        add(path, "unknown_ref", "La task da aspettare non è creata da un passo precedente.");
      }
      return;
    }
    case "claude": {
      requireText([["l'istruzione", step.instruction]], path, add);
      if (step.outcomes.length === 0 && step.fields.length === 0) {
        add(path, "incomplete", "Claude deve restituire almeno un'uscita o un campo.");
      }
      const bad = (o: string) => blank(o) || o.includes("/");
      if (step.outcomes.some(bad) || new Set(step.outcomes).size !== step.outcomes.length) {
        add(path, "incomplete", "Le uscite devono avere nomi diversi, senza «/».");
      }
      if (step.fields.some((f) => blank(f.key)))
        add(path, "incomplete", "Un campo non ha la chiave.");
      for (const ref of step.inputs) {
        if (!scope.fields.has(ref))
          add(path, "unknown_ref", `Il dato «${ref}» non è disponibile in questo punto.`);
      }
      for (const key of Object.keys(step.branches)) {
        if (!step.outcomes.includes(key))
          add(path, "unknown_ref", `Il ramo «${key}» non è un'uscita del passo.`);
      }
      return;
    }
    case "condition":
      checkCondition(step.when, scope, path, add);
      return;
    case "forEach": {
      if (
        !requireText(
          [
            ["l'elenco", step.list],
            ["il nome dell'elemento", step.as],
          ],
          path,
          add,
        )
      )
        return;
      if (/[./]/.test(step.as))
        add(path, "incomplete", "Il nome dell'elemento non può contenere «.» o «/».");
      const f = scope.fields.get(step.list);
      if (!f)
        add(path, "unknown_ref", `L'elenco «${step.list}» non è disponibile in questo punto.`);
      else if (f.type !== "list") add(path, "type_mismatch", `«${f.label}» non è un elenco.`);
      return;
    }
    case "repeatUntil":
      if (!Number.isInteger(step.max) || step.max < 1 || step.max > AUTOMATION_LIMITS.repeatMax) {
        add(path, "limit", `Il massimo di giri va da 1 a ${AUTOMATION_LIMITS.repeatMax}.`);
      }
      checkCondition(step.until, scope, path, add);
      return;
  }
}

const ORDERED: FieldType[] = ["number", "date"];
const TEXTUAL: FieldType[] = ["text", "email", "person", "list"];

/** Un confronto alla volta: al primo problema si ferma, così ogni foglia dà al più un errore. */
function checkCondition(cond: Condition, scope: Scope, path: string, add: Add): void {
  cond.all?.forEach((c) => checkCondition(c, scope, path, add));
  cond.any?.forEach((c) => checkCondition(c, scope, path, add));
  const leaf = cond.left !== undefined || cond.op !== undefined || cond.right !== undefined;
  if (!leaf) {
    if (cond.all === undefined && cond.any === undefined)
      add(path, "incomplete", "La condizione è vuota.");
    return;
  }
  const unary = cond.op === "empty" || cond.op === "not_empty";
  if (!cond.left || !cond.op || (!unary && !cond.right)) {
    add(path, "incomplete", "Il confronto è a metà.");
    return;
  }
  const typeOf = (o: Condition["left"]): FieldType | "value" | null => {
    if (!o) return null;
    if ("value" in o) return "value";
    return scope.fields.get(o.ref)?.type ?? null;
  };
  for (const o of [cond.left, unary ? undefined : cond.right]) {
    if (o && "ref" in o && !scope.fields.has(o.ref)) {
      add(path, "unknown_ref", `Il dato «${o.ref}» non è disponibile in questo punto.`);
      return;
    }
  }
  if (unary) return;
  const left = typeOf(cond.left);
  const right = cond.right!;
  const mismatch = (msg: string) => add(path, "type_mismatch", msg);
  if (left === "value" || left === null) return;
  const label = (scope.fields.get((cond.left as { ref: string }).ref) as DataField).label;
  if (cond.op === "gt" || cond.op === "lt") {
    if (!ORDERED.includes(left)) return mismatch(`«${label}» non è un numero né una data.`);
    if ("value" in right) {
      const ok =
        left === "number" ? typeof right.value === "number" : typeof right.value === "string";
      if (!ok) return mismatch(`Il valore non è ${left === "number" ? "un numero" : "una data"}.`);
    }
    return;
  }
  if (cond.op === "contains") {
    if (!TEXTUAL.includes(left)) mismatch(`«${label}» non è un testo né un elenco.`);
    return;
  }
  // is / is_not
  if (left === "boolean" && "value" in right && typeof right.value !== "boolean") {
    return mismatch(`«${label}» è sì/no: confrontalo con vero o falso.`);
  }
  if (left !== "boolean" && "value" in right && typeof right.value === "boolean") {
    return mismatch(`«${label}» non è sì/no.`);
  }
  if ("ref" in right) {
    const r = typeOf(right);
    if (r !== null && r !== "value" && (r === "boolean") !== (left === "boolean")) {
      mismatch("I due dati sono di tipo diverso.");
    }
  }
}
