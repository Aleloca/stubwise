import i18n from "../../i18n";
import { visiblePeopleFor } from "../access/whoCan";
import { applyActions, type FailureCode } from "../api-mutations";
import { requireReauth } from "../auth/reauth";
import type { ProposedAction, ScriptStep, Task, Utterance } from "../model";
import type { BusyReason } from "../projectSettings/types";
import { PEOPLE } from "../seed/people";
import {
  archivedProjectIdsFor,
  canSeeConversation,
  gate,
  newId,
  nextSeq,
  now,
  state,
  storeGeneration,
  visibleProjectIds,
} from "../store";
import { appendExecuted, notifyConversationChange } from "../stream";
import type { TaskBusyReason } from "../taskDelete";
import type { UndoView } from "../types";
import { CLAUDE_CATALOG, declaredClassOf, isCatalogFn } from "./catalog";
import { classOfGroup } from "./classes";
import type {
  ClassReason,
  ClaudeActionFn,
  ClaudeActionRecord,
  ExecutedFailure,
  ObjectRef,
} from "./types";

// Eseguire per classe e «Annulla» (area 10a, Task 5).
//
// - Un gruppo di azioni del catalogo gira con `executeGroup`: tutto o niente
//   (`applyActions` con `catalogOnly`), ogni azione col suo segno «per conto
//   di» (`runAsClaude`, un id per azione), e a gruppo riuscito una riga per
//   azione in `state.claudeActions`.
// - «Annulla» è un'azione nuova: gli inversi, in ordine inverso, con i
//   permessi di ADESSO, tutti o nessuno. Solo chi l'ha chiesta; mai se
//   qualcuno, dopo, ha scritto sugli stessi oggetti («com'era»).
// - «Dopo» si legge con `seq` (`nextSeq()`), mai con `at`: l'orologio del
//   prototipo è fermo e ogni scrittura della sessione ha lo stesso `at`
//   (ruling del controller (pre-flight), P4). Le scritture del gruppo stesso
//   non contano: la riga prende il suo `seq` DOPO il gruppo, e in più le
//   scritture col segno di un'azione del gruppo (`claudeActionId`) sono
//   escluse per nome.

type GroupFailure = {
  ok: false;
  index: number;
  code: FailureCode;
  reasons?: (BusyReason | TaskBusyReason)[];
};

/**
 * Le azioni di classe C di un gruppo che chiederebbero il codice adesso: la
 * riconferma manca o è scaduta (o la chiamata è di un PAT). Si guarda la
 * classe dichiarata (`REAUTH_REQUIRED`), non il rifiuto della scrittura:
 * `saveStorage` senza chiave nuova non lo chiederebbe da sé.
 */
export function reauthMissing(me: string, actions: Pick<ProposedAction, "fn">[]): boolean {
  return actions.some(
    (a) =>
      isCatalogFn(a.fn) &&
      declaredClassOf(a.fn) === "C" &&
      requireReauth(me, CLAUDE_CATALOG[a.fn].apiFn) !== null,
  );
}

/**
 * Esegue un gruppo di azioni del catalogo a nome di `me`, con
 * `applyActions(…, { catalogOnly: true })`: una `fn` fuori dal catalogo è
 * `invalid` prima di ogni scrittura (Review Focus 3). Una C senza riconferma
 * fresca non parte. Scrive le righe da `Applied.catalogRuns`; gli `after`
 * li chiama il chiamante a gruppo riuscito.
 */
export function executeGroup(
  me: string,
  conversationId: string,
  actions: ProposedAction[],
  cls: "A" | "B" | "C",
):
  | {
      ok: true;
      groupId: string;
      codes: string[];
      /** Il codice dell'oggetto di ogni azione, nell'ordine: la riga eseguita lo scrive (Task 9). */
      objectCodes: (string | null)[];
      projectIds: string[];
      runs: Task[];
      after: ((gen: number) => Promise<void>)[];
    }
  | GroupFailure {
  if (cls === "C" && reauthMissing(me, actions)) {
    const index = actions.findIndex((a) => reauthMissing(me, [a]));
    return { ok: false, index: Math.max(index, 0), code: "reauth_required" };
  }
  const ids: string[] = [];
  const applied = applyActions(me, actions, {
    catalogOnly: true,
    mark: (index) => ({ actionId: (ids[index] = newId("ca")), undoOfActionId: null }),
  });
  if (!applied.ok) return applied;
  const groupId = newId("cg");
  const at = now();
  actions.forEach((action, index) => {
    const run = applied.catalogRuns[index]!;
    state.claudeActions.push({
      id: ids[index]!,
      groupId,
      conversationId,
      personId: me,
      at,
      // Preso DOPO il gruppo: le sue scritture vengono prima della riga.
      seq: nextSeq(),
      fn: action.fn as ClaudeActionFn,
      args: structuredClone(action.args),
      cls,
      inverse: run.inverse,
      objects: run.objects,
      undone: null,
    });
  });
  return {
    ok: true,
    groupId,
    codes: applied.codes,
    objectCodes: applied.catalogRuns.map(
      (run) => run?.codes[0] ?? (run?.objects[0] ? projectCodeOfRef(run.objects[0]) : null),
    ),
    projectIds: applied.projectIds,
    runs: applied.runs,
    after: applied.after,
  };
}

// --- il passo `executed` della conversazione libera ---------------------------

type ExecutedDraft = Extract<ScriptStep, { step: "event" }>["event"] & { type: "executed" };

/** Il motivo della scheda in una frase, per «I'm asking first: …» (R-G5: solo persone visibili). */
function reasonPhrase(reasons: ClassReason[]): string {
  const first = reasons[0];
  if (!first) return i18n.t("claude.answers.classReason.notifiesOthers");
  switch (first.kind) {
    case "notifies":
      return first.personIds.length > 0
        ? i18n.t("claude.answers.classReason.notifies", {
            names: first.personIds.map((id) => nameOf(id) ?? "").join(", "),
          })
        : i18n.t("claude.answers.classReason.notifiesOthers");
    case "automation":
      return i18n.t("claude.answers.classReason.automation", {
        code: state.projectsById.get(first.projectId)?.code ?? "",
      });
    case "irreversible":
      return i18n.t("claude.answers.classReason.irreversible");
    case "reauth":
      return i18n.t("claude.answers.classReason.reauth");
  }
}

/** L'ultimo `say` prima del passo `index`: la frase «fatto» di quell'azione. */
function sayBefore(steps: ScriptStep[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (steps[i]!.step === "say") return i;
  return -1;
}

/**
 * Prima che la risposta entri nel flusso (`freeTurn`, senza attese in
 * mezzo): ogni `executed` `pending` del motore si esegue se la classe,
 * ricalcolata adesso, è ancora A — e la sua riga `done` coi codici, o
 * `failed` col motivo («Didn't run», senza la frase «fatto»), entra nel
 * flusso subito, fuori dalla coda che «Ferma» taglia —; se è salita diventa
 * una scheda aperta con classe e motivi, e la frase «fatto» diventa
 * «I'm asking first: …» (`classRaised`). Le proposte del motore ricevono la
 * loro classe calcolata (`cls`, `reasons`): la scheda la legge, non la deduce.
 */
export function prepareExecuted(
  me: string,
  conversationId: string,
  input: ScriptStep[],
): {
  steps: ScriptStep[];
  runs: Task[];
  after: ((gen: number) => Promise<void>)[];
  /** I progetti dei gruppi eseguiti: le loro righe non sono più nei passi. */
  projectIds: string[];
} {
  const steps = [...input];
  const projectIds: string[] = [];
  const runs: Task[] = [];
  const after: ((gen: number) => Promise<void>)[] = [];
  const drop = new Set<number>();
  steps.forEach((step, index) => {
    if (step.step !== "event") return;
    const event = step.event;
    if (event.type === "proposal" && event.cls === undefined) {
      const { cls, reasons } = classOfGroup(me, event.actions);
      steps[index] = { step: "event", event: { ...event, cls, reasons } };
      return;
    }
    if (event.type !== "executed" || event.status !== "pending") return;
    const said = sayBefore(steps, index);
    const latest = classOfGroup(me, event.actions);
    if (latest.cls !== "A") {
      if (said !== -1) {
        steps[said] = {
          step: "say",
          text: i18n.t("claude.answers.classRaised", { reason: reasonPhrase(latest.reasons) }),
        };
      }
      steps[index] = {
        step: "event",
        event: {
          type: "proposal",
          proposalId: newId("prop"),
          requesterId: me,
          actions: event.actions,
          status: "open",
          cls: latest.cls,
          reasons: latest.reasons,
        },
      };
      return;
    }
    const result = executeGroup(me, conversationId, event.actions, "A");
    let next: ExecutedDraft;
    if (result.ok) {
      next = {
        ...event,
        groupId: result.groupId,
        status: "done",
        resultCodes: result.codes,
        objectCodes: result.objectCodes,
      };
      runs.push(...result.runs);
      after.push(...result.after);
      for (const id of result.projectIds) if (!projectIds.includes(id)) projectIds.push(id);
    } else {
      const errorText: Utterance = {
        key: `claude.executed.failed.${result.code}`,
        params: { action: event.actions[result.index]?.summary ?? "" },
      };
      next = {
        ...event,
        status: "failed",
        errorText,
        failure: failureOf(me, event.actions, result),
      };
      // Non è stato fatto niente: la riga «Didn't run» lo dice, la frase «fatto» no.
      if (said !== -1) drop.add(said);
    }
    // La riga entra nel flusso ADESSO, insieme al gruppo: «Ferma» taglia lo
    // stream, mai la riga di ciò che è già stato fatto. Lo stream anima solo
    // il testo che segue.
    appendExecuted(conversationId, next);
    drop.add(index);
  });
  return { steps: steps.filter((_, i) => !drop.has(i)), runs, after, projectIds };
}

/**
 * Il progetto di un'azione che non è partita, dai suoi argomenti: quello
 * nominato, o quello della task o della richiesta. Solo se chi chiede lo
 * vede (R-G5): di uno che non vede la riga non dice niente.
 */
function projectOfArgs(me: string, args: Record<string, unknown>): string | null {
  const id = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : null);
  const projectId =
    id("projectId") ??
    state.tasksById.get(id("id") ?? id("taskId") ?? "")?.projectId ??
    state.requests.find((r) => r.id === (id("requestId") ?? id("id")))?.projectId ??
    null;
  return projectId !== null && seesProject(me, projectId) ? projectId : null;
}

/** Il rifiuto di un'azione A all'invio, in forma di dato per «Didn't run: … · Who?» (Task 9). */
function failureOf(me: string, actions: ProposedAction[], failure: GroupFailure): ExecutedFailure {
  const action = actions[failure.index];
  const projectId = action ? projectOfArgs(me, action.args) : null;
  return {
    code: failure.code,
    index: failure.index,
    whoAction: action && isCatalogFn(action.fn) ? CLAUDE_CATALOG[action.fn].whoAction : null,
    projectId,
    projectCode: projectId === null ? null : (state.projectsById.get(projectId)?.code ?? null),
    ...(failure.reasons ? { reasons: failure.reasons } : {}),
  };
}

// --- «com'era» e «Annulla» -----------------------------------------------------

const nameOf = (id: string | null): string | null =>
  id === null ? null : (PEOPLE.find((p) => p.id === id)?.name ?? null);

interface Write {
  seq: number;
  byId: string | null;
  claudeActionId?: string;
}

/** La chiave di una voce del registro: lo stesso oggetto è stesso progetto, tipo e id. */
const changeKey = (e: { projectId: string | null; object: { type: string; id: string } }) =>
  `${e.projectId ?? ""}|${e.object.type}|${e.object.id}`;

/** Le scritture contate sugli oggetti di un'azione (aprire o leggere non conta). */
function writesOn(record: ClaudeActionRecord, ref: ObjectRef): Write[] {
  const withSeq = <W extends { seq?: number }>(w: W): w is W & { seq: number } =>
    typeof w.seq === "number";
  switch (ref.kind) {
    case "task":
      return [
        // Un'attività (commento, cambio di campo, decisione)…
        ...state.activity
          .filter((a) => a.taskId === ref.id)
          .filter(withSeq)
          .map((a) => ({
            seq: a.seq,
            byId: a.authorId,
            ...(a.claudeActionId ? { claudeActionId: a.claudeActionId } : {}),
          })),
        // …una sessione di lavoro nata sulla task…
        ...state.conversations
          .filter((c) => c.kind === "task_run" && c.taskId === ref.id)
          .filter(withSeq)
          .map((c) => ({ seq: c.seq, byId: c.ownerId })),
        // …o l'eliminazione (la voce `task.deleted`).
        ...state.changelog
          .filter((e) => e.object.type === "task" && e.object.id === ref.id)
          .filter(withSeq)
          .map((e) => ({
            seq: e.seq,
            byId: e.actorId,
            ...(e.claudeActionId ? { claudeActionId: e.claudeActionId } : {}),
          })),
      ];
    case "request":
    case "milestone":
      return state.objectWrites.filter((w) => w.kind === ref.kind && w.id === ref.id);
    case "subscription": {
      const sub = state.alertSubscriptions.find(
        (s) =>
          s.personId === record.personId && s.projectId === ref.projectId && s.type === ref.type,
      );
      return (sub?.history ?? []).filter(withSeq).map((h) => ({ seq: h.seq, byId: sub!.personId }));
    }
    default: {
      // Progetto, membro, impostazioni: le voci del registro sullo STESSO
      // oggetto di quelle che l'azione ha scritto.
      const own = new Set(
        state.changelog.filter((e) => e.claudeActionId === record.id).map(changeKey),
      );
      return state.changelog
        .filter((e) => own.has(changeKey(e)))
        .filter(withSeq)
        .map((e) => ({
          seq: e.seq,
          byId: e.actorId,
          ...(e.claudeActionId ? { claudeActionId: e.claudeActionId } : {}),
        }));
    }
  }
}

/**
 * La prima scrittura sugli oggetti del gruppo con `seq` maggiore di quello
 * della riga, che non sia del gruppo stesso (`claudeActionId`).
 */
export function laterChangeOf(
  group: ClaudeActionRecord[],
): { byId: string | null; ref: ObjectRef } | null {
  const own = new Set(group.map((r) => r.id));
  let first: { seq: number; byId: string | null; ref: ObjectRef } | null = null;
  for (const record of group) {
    for (const ref of record.objects) {
      for (const w of writesOn(record, ref)) {
        if (w.seq <= record.seq) continue;
        if (w.claudeActionId !== undefined && own.has(w.claudeActionId)) continue;
        if (!first || w.seq < first.seq) first = { seq: w.seq, byId: w.byId, ref };
      }
    }
  }
  return first && { byId: first.byId, ref: first.ref };
}

/** Il progetto di un oggetto, se c'è. */
function projectOfRef(ref: ObjectRef): string | null {
  switch (ref.kind) {
    case "task":
      return (
        state.tasksById.get(ref.id)?.projectId ??
        state.deletedTasks.find((d) => d.id === ref.id)?.projectId ??
        null
      );
    case "request":
      return state.requests.find((r) => r.id === ref.id)?.projectId ?? null;
    case "milestone":
      return state.milestones.find((m) => m.id === ref.id)?.projectId ?? null;
    case "project":
      return ref.id;
    case "member":
    case "projectSettings":
    case "subscription":
      return ref.projectId;
    case "instanceSetting":
      return null;
  }
}

/** Il codice del progetto di un oggetto di progetto (progetto, membro, impostazioni, iscrizione). */
function projectCodeOfRef(ref: ObjectRef): string | null {
  if (ref.kind === "task" || ref.kind === "request" || ref.kind === "milestone") return null;
  const projectId = projectOfRef(ref);
  return projectId === null ? null : (state.projectsById.get(projectId)?.code ?? null);
}

/** Chi guarda vede il progetto, aperto o da archiviato (chi l'ha archiviato lo conosce). */
const seesProject = (viewerId: string, projectId: string) =>
  visibleProjectIds(viewerId).has(projectId) || archivedProjectIdsFor(viewerId).has(projectId);

/**
 * Il codice di un oggetto per chi guarda: solo se lo vede (R-G5). Una task
 * eliminata si legge come una che non esiste.
 */
function codeFor(viewerId: string, ref: ObjectRef): string | null {
  const projectId = projectOfRef(ref);
  if (projectId === null || !seesProject(viewerId, projectId)) return null;
  switch (ref.kind) {
    case "task":
      return state.tasksById.get(ref.id)?.code ?? null;
    case "request":
      return state.requests.find((r) => r.id === ref.id)?.code ?? null;
    case "milestone":
      return null;
    default:
      return state.projectsById.get(projectId)?.code ?? null;
  }
}

/** Chi ha scritto dopo e l'oggetto, come li può leggere chi guarda (R-G5). */
function describeLater(
  viewerId: string,
  later: { byId: string | null; ref: ObjectRef },
): { byName: string | null; code: string | null } {
  const sees = later.byId !== null && visiblePeopleFor(viewerId).has(later.byId);
  return { byName: sees ? nameOf(later.byId) : null, code: codeFor(viewerId, later.ref) };
}

const groupOf = (groupId: string) => state.claudeActions.filter((r) => r.groupId === groupId);

/** Gli inversi di un gruppo chiederebbero il codice adesso? */
const inversesNeedReauth = (me: string, group: ClaudeActionRecord[]) =>
  group.some((r) => r.inverse !== null && reauthMissing(me, [r.inverse]));

/** Lo stato di «Annulla» di un gruppo per chi guarda. */
export function undoViewOf(viewerId: string, groupId: string): UndoView {
  const group = groupOf(groupId);
  const head = group[0];
  if (!head) return { state: "not_undoable" };
  if (head.personId !== viewerId) return { state: "not_yours" };
  if (head.undone) {
    return { state: "undone", byName: nameOf(head.undone.byId) ?? "", at: head.undone.at };
  }
  if (group.some((r) => r.inverse === null)) return { state: "not_undoable" };
  const later = laterChangeOf(group);
  if (later) return { state: "changed_after", ...describeLater(viewerId, later) };
  return { state: "available", needsReauth: inversesNeedReauth(viewerId, group) };
}

export type UndoResult =
  | { ok: true }
  | {
      ok: false;
      error: "not_found" | "not_yours" | "already_undone" | "not_undoable" | "reauth_required";
    }
  | { ok: false; error: "changed_after"; byName: string | null; code: string | null }
  /** `whoAction` è quella della voce dell'inverso (`null` solo per `setSubscription`, P19). */
  | {
      ok: false;
      error: "forbidden";
      whoAction: string | null;
      projectId: string | null;
      /** Il codice dello stesso progetto, per la frase («… in OLV»); `null` con `projectId`. */
      projectCode?: string | null;
    }
  | { ok: false; error: "busy"; reasons: (BusyReason | TaskBusyReason)[] };

/**
 * «Annulla» di un gruppo: solo chi l'ha chiesta, una volta, se ogni azione
 * ha un inverso e nessuno ha scritto dopo sugli stessi oggetti. Gli inversi
 * girano in ordine inverso, con i permessi di adesso, tutti o nessuno, col
 * segno dell'«Annulla» (`undoOfActionId`): `publish` e `publishAlert` non
 * scrivono, l'avviso c'era già. Un rifiuto dell'inverso diventa la risposta.
 */
export async function undoClaudeActions(
  conversationId: string,
  groupId: string,
): Promise<UndoResult> {
  const gen = storeGeneration();
  const me = await gate("claude.undo");
  const c = state.conversations.find((x) => x.id === conversationId);
  const group = groupOf(groupId).filter((r) => r.conversationId === conversationId);
  if (!c || !canSeeConversation(me, c) || group.length === 0) {
    return { ok: false, error: "not_found" };
  }
  if (group[0]!.personId !== me) return { ok: false, error: "not_yours" };
  if (group[0]!.undone) return { ok: false, error: "already_undone" };
  if (group.some((r) => r.inverse === null)) return { ok: false, error: "not_undoable" };
  const later = laterChangeOf(group);
  if (later) return { ok: false, error: "changed_after", ...describeLater(me, later) };
  if (inversesNeedReauth(me, group)) return { ok: false, error: "reauth_required" };

  const reversed = [...group].reverse();
  const inverses: ProposedAction[] = reversed.map((r) => ({
    fn: r.inverse!.fn,
    args: r.inverse!.args,
    summary: "",
  }));
  const applied = applyActions(me, inverses, {
    catalogOnly: true,
    mark: (index) => ({ actionId: newId("ca"), undoOfActionId: reversed[index]!.id }),
  });
  if (!applied.ok) return refusalOf(me, applied, reversed);
  const at = now();
  for (const r of group) r.undone = { at, byId: me };
  notifyConversationChange(conversationId);
  for (const start of applied.after) await start(gen);
  return { ok: true };
}

/** Il rifiuto di un inverso come risposta di «Annulla». */
function refusalOf(me: string, failure: GroupFailure, reversed: ClaudeActionRecord[]): UndoResult {
  const record = reversed[failure.index]!;
  switch (failure.code) {
    case "forbidden": {
      const found = record.objects.map(projectOfRef).find((p) => p !== null) ?? null;
      // Un progetto che chi chiede non vede più non si nomina (R-G5).
      const projectId = found !== null && seesProject(me, found) ? found : null;
      return {
        ok: false,
        error: "forbidden",
        whoAction: CLAUDE_CATALOG[record.inverse!.fn].whoAction,
        projectId,
        projectCode: projectId === null ? null : (state.projectsById.get(projectId)?.code ?? null),
      };
    }
    case "busy":
      return { ok: false, error: "busy", reasons: failure.reasons ?? [] };
    case "reauth_required":
      return { ok: false, error: "reauth_required" };
    case "not_found":
      return { ok: false, error: "not_found" };
    default:
      // `invalid`, `conflict`, `other`: lo stato di adesso non ammette più
      // l'inverso, e non è cambiato niente.
      return { ok: false, error: "not_undoable" };
  }
}
