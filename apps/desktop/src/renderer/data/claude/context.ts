import { sees } from "../access";
import { automationById, canSeeAutomation } from "../automations/visibility";
import { threadFor } from "../mail/reads";
import {
  AI_TABS,
  APP_ROUTES,
  isAdminSection,
  isProjectSection,
  isProjectSettingsSection,
} from "../routes";
import { presentEvent, state, visibleProjectIds } from "../store";
import type { ContextRef, ConversationEvent, FieldRef } from "../types";

// Il contesto del riquadro di Claude (area 10a, Task 8): un riferimento a
// ciò che chi scrive sta guardando, riletto ADESSO con la sua visibilità. Lo
// leggono il chip (`describeContext`), la riga «· on ACQ-14» sotto un
// messaggio e il turno della libera (il progetto per le risposte e per i
// consumi). Un oggetto invisibile e uno inesistente rispondono uguale:
// `null`, nessun codice né progetto (R-G5).

/** Il chip di un contesto: codice (se c'è), la parola da tradurre e il progetto. */
export interface ContextDescription {
  code: string | null;
  /** La chiave i18n della parola del tipo o della pagina («task», «Tasks», «Settings → {{section}}»). */
  labelKey: string;
  projectId: string | null;
  /** `number`: la PR; `sectionKey`: la chiave della voce di Settings, tradotta dentro `labelKey`. */
  params?: { number?: number; sectionKey?: string };
}

const K = "claude.panel.chip";

/** Gli oggetti che l'indirizzo nomina col codice: il riquadro li risolve in id (`contextIdOf`). */
export type CodedContextKind = "task" | "release" | "support" | "automation";

/** Il progetto, se chi guarda lo vede. */
function visibleProject(me: string, projectId: string) {
  return visibleProjectIds(me).has(projectId) ? state.projectsById.get(projectId) : undefined;
}

/** Il contesto letto come `me` lo vede adesso; `null` = invisibile o inesistente. */
export function contextOf(me: string, ref: ContextRef): ContextDescription | null {
  switch (ref.kind) {
    case "task": {
      const task = state.tasksById.get(ref.taskId);
      if (!task || !sees(me, task.projectId)) return null;
      return { code: task.code, labelKey: `${K}.kind.task`, projectId: task.projectId };
    }
    case "request": {
      const req = state.requests.find((r) => r.id === ref.requestId);
      if (!req || !sees(me, req.projectId)) return null;
      return { code: req.code, labelKey: `${K}.kind.request`, projectId: req.projectId };
    }
    case "support": {
      const c = state.supportConversations.find((x) => x.id === ref.conversationId);
      if (!c || !sees(me, c.projectId)) return null;
      return { code: c.code, labelKey: `${K}.kind.support`, projectId: c.projectId };
    }
    case "pr": {
      const pr = state.openPrs.find((p) => p.id === ref.prId);
      const project = pr ? visibleProject(me, pr.projectId) : undefined;
      if (!pr || !project) return null;
      // Una PR aperta dalla pipeline senza numero (ruling T2): la parola senza «#».
      return typeof pr.number === "number"
        ? {
            code: project.code,
            labelKey: `${K}.kind.pr`,
            projectId: project.id,
            params: { number: pr.number },
          }
        : { code: project.code, labelKey: `${K}.kind.prNoNumber`, projectId: project.id };
    }
    case "automation": {
      const a = automationById(ref.automationId);
      if (!a || !canSeeAutomation(me, a)) return null;
      return { code: a.code, labelKey: `${K}.kind.automation`, projectId: a.projectId };
    }
    case "release": {
      const r = state.releases.find((x) => x.id === ref.releaseId);
      if (!r || !sees(me, r.projectId)) return null;
      return { code: r.code, labelKey: `${K}.kind.release`, projectId: r.projectId };
    }
    case "settings": {
      if (ref.projectId === null) {
        const sectionKey = instanceSectionKey(ref.section);
        return sectionKey
          ? {
              code: null,
              labelKey: `${K}.instanceSettings`,
              projectId: null,
              params: { sectionKey },
            }
          : null;
      }
      const project = visibleProject(me, ref.projectId);
      if (!project || !isProjectSettingsSection(ref.section)) return null;
      return {
        code: project.code,
        labelKey: `${K}.projectSettings`,
        projectId: project.id,
        params: { sectionKey: `settings.sections.${ref.section}` },
      };
    }
    case "mail": {
      // D1, `mailbox_owner`: solo la propria posta — una conversazione che
      // chi guarda vede (`canSeeMessage`, admin compresi), o l'email nuova
      // di chi ha una casella. Nessun codice: il chip dice «email».
      const mine =
        ref.threadId === null
          ? state.mailboxes.some((b) => b.personId === me)
          : threadFor(me, ref.threadId) !== null;
      return mine ? { code: null, labelKey: `${K}.kind.mail`, projectId: null } : null;
    }
    case "page": {
      if (ref.projectId === null) {
        return (APP_ROUTES as readonly string[]).includes(ref.route)
          ? { code: null, labelKey: `nav.${ref.route}`, projectId: null }
          : null;
      }
      const project = visibleProject(me, ref.projectId);
      if (!project || !isProjectSection(ref.route)) return null;
      return {
        code: project.code,
        labelKey: `project.sections.${ref.route}`,
        projectId: project.id,
      };
    }
  }
}

/** La voce d'Amministrazione: `ai`, o una sua scheda (`ai.models`). */
function instanceSectionKey(section: string): string | null {
  const [id, tab] = section.split(".");
  if (!id || !isAdminSection(id)) return null;
  if (tab === undefined) return `admin.sections.${id}`;
  return id === "ai" && (AI_TABS as readonly string[]).includes(tab)
    ? `admin.ai.tabs.${tab}`
    : null;
}

/**
 * Un evento come lo legge `me` (R-G5): il contesto di un messaggio che `me`
 * non vede (più) non esce, nemmeno come id — gli id del prototipo portano il
 * codice del progetto, e già la sua presenza direbbe che l'oggetto esiste.
 * Lo usano il dettaglio e lo stream: ogni porta da cui un evento arriva a
 * chi guarda.
 */
export function presentEventFor(
  me: string,
  log: readonly ConversationEvent[],
  index: number,
): ConversationEvent {
  const event = presentEvent(log, index);
  if (event.type === "user" && event.context && !contextOf(me, event.context)) {
    delete event.context;
  }
  // Area 10b: una bozza la legge per intero solo chi vede l'oggetto del
  // campo; il corpo di un'email solo il proprietario della casella — chi ha
  // chiesto la bozza —, nemmeno chi vede la stessa conversazione.
  if (event.type === "draft" && event.field && !seesField(me, event.field, askerOf(log, index))) {
    event.field = null;
    event.text = "";
    delete event.sources;
  }
  return event;
}

/** Chi ha chiesto: l'autore dell'ultimo messaggio prima dell'evento. */
function askerOf(log: readonly ConversationEvent[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.type === "user") return e.authorId;
  }
  return null;
}

/** `me` vede l'oggetto del campo (per il corpo di un'email: è sua la casella). */
function seesField(me: string, field: FieldRef, asker: string | null): boolean {
  switch (field.kind) {
    case "supportReply":
      return contextOf(me, { kind: "support", conversationId: field.conversationId }) !== null;
    case "releaseNotes":
      return contextOf(me, { kind: "pr", prId: field.prId }) !== null;
    case "taskDescription":
      return contextOf(me, { kind: "task", taskId: field.taskId }) !== null;
    case "mailBody":
      return me === asker && contextOf(me, { kind: "mail", threadId: field.threadId }) !== null;
  }
}

/** Lo stesso per il contesto con cui una libera è nata (righe e dettaglio). */
export function withVisibleContext<T extends { context?: ContextRef | null }>(
  me: string,
  row: T,
): T {
  if (row.context && !contextOf(me, row.context)) row.context = null;
  return row;
}

/** L'id dell'oggetto col codice, se chi guarda lo vede; `null` altrimenti (R-G5). */
export function contextIdFor(me: string, kind: CodedContextKind, code: string): string | null {
  switch (kind) {
    case "task": {
      const task = state.tasks.find((t) => t.code === code);
      return task && sees(me, task.projectId) ? task.id : null;
    }
    case "release": {
      const r = state.releases.find((x) => x.code === code);
      return r && sees(me, r.projectId) ? r.id : null;
    }
    case "support": {
      const c = state.supportConversations.find((x) => x.code === code);
      return c && sees(me, c.projectId) ? c.id : null;
    }
    case "automation": {
      const a = state.automations.find((x) => x.code === code);
      return a && canSeeAutomation(me, a) ? a.id : null;
    }
  }
}
