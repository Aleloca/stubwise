import { prospectiveIssues } from "../automations/reads";
import {
  checkNewAutomation,
  createAutomationAs,
  deleteDraftAs,
  saveDraftAs,
} from "../automations/writes";
import { parseCriteria } from "../../domain/filters";
import { deleteFilterAs, saveFilterAs } from "../api-mutations";
import { GROUP_BYS, TASK_VIEWS } from "../routes";
import type { Automation, AutomationFlow, AutomationMeta, GroupBy, TaskView } from "../types";
import { state } from "../store";
import type { CatalogEntry, CatalogRun } from "./catalog";
import { PRODUCT_ENTRIES, type ProductCatalogFn } from "./catalogProduct";
import type { CatalogInverse } from "./types";

// Le voci del catalogo di Claude nate col 10b (`catalog.ts` le unisce alle
// sue, come chiede il minore T4 del 10a): le BOZZE di automazione. Claude
// crea, salva ed elimina una bozza; non la accende e non la pubblica mai
// (maintainer): una bozza spenta non avvisa e non fa partire niente, quindi
// `classOf` non ha motivi di dati per queste voci. Il «Who?» è uno solo,
// `manageProjectAutomations`: dal riquadro nascono solo bozze di progetto
// (ruling del controller (pre-flight), P3). La prova (`trialAs`) non è una
// voce: non scrive niente da annullare (scelta del costruttore). E il
// filtro salvato personale (Task 9): salvarlo ed eliminarlo.

/** Le funzioni delle voci di questo file. */
export type MoreCatalogFn =
  | "createAutomation"
  | "saveAutomationDraft"
  | "deleteAutomationDraft"
  | "saveFilter"
  | "deleteFilter"
  | ProductCatalogFn;

type Args = Record<string, unknown>;

const invalid = (what: string) => new Error(`invalid: ${what}`);

/** Un'automazione toccata: il suo codice, il suo progetto, l'oggetto del «com'era». */
const onAutomation = (a: Automation, inverse: CatalogInverse): CatalogRun => ({
  codes: [a.code],
  projectIds: a.projectId === null ? [] : [a.projectId],
  inverse,
  objects: [{ kind: "automation", id: a.id }],
});

/** Un filtro salvato toccato: nessun codice né progetto (è solo di chi chiede). */
const onFilter = (id: string, inverse: CatalogInverse): CatalogRun => ({
  codes: [],
  projectIds: [],
  inverse,
  objects: [{ kind: "filter", id }],
});

/** Ha la forma di un flusso? Il resto lo dice `prospectiveIssues`. */
const isFlow = (flow: unknown): flow is AutomationFlow =>
  typeof flow === "object" &&
  flow !== null &&
  typeof (flow as AutomationFlow).trigger === "object" &&
  Array.isArray((flow as AutomationFlow).steps);

export const MORE_ENTRIES: Record<MoreCatalogFn, Omit<CatalogEntry, "fn">> = {
  createAutomation: {
    apiFn: "automations.createAutomation",
    baseClass: "A",
    undoable: true,
    whoAction: "manageProjectAutomations",
    run(me, args) {
      // Solo bozze di progetto: il «Who?» della voce è uno solo (P3).
      const projectId = args.projectId;
      if (typeof projectId !== "string") throw invalid("project");
      // Prima chi chiede (`not_found`, `forbidden`), poi il flusso: un
      // problema del flusso non dice niente di un progetto che non vede.
      checkNewAutomation(me, projectId);
      // Il motore lo ha controllato (`validateAutomationFlow`); il livello dati lo
      // ricontrolla con la stessa regola.
      const flow = args.flow;
      if (!isFlow(flow) || prospectiveIssues(me, projectId, flow).length > 0) throw invalid("flow");
      // Stato e proprietario non si leggono dagli argomenti: nasce spenta, di nessuno.
      const a = createAutomationAs(me, {
        name: typeof args.name === "string" ? args.name : "",
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        projectId,
        flow,
      });
      // L'eccezione senza scheda, come `createTask`: «Annulla» la elimina.
      return onAutomation(a, { fn: "deleteAutomationDraft", args: { id: a.id } });
    },
  },
  saveAutomationDraft: {
    apiFn: "automations.saveDraft",
    baseClass: "A",
    undoable: true,
    whoAction: "manageProjectAutomations",
    run(me, args) {
      const id = args.id as string;
      const meta = (args.meta ?? {}) as AutomationMeta;
      const before = state.automations.find((x) => x.id === id);
      const last = before?.versions.at(-1);
      // Il valore di prima, letto prima di scrivere (copiato: la scrittura lo sostituisce).
      const was = last && {
        draft: last.publishedAt === null,
        flow: structuredClone(last.flow),
        name: before!.name,
        description: before!.description,
      };
      const a = saveDraftAs(me, id, args.flow as AutomationFlow, meta);
      const metaWas: Args = {
        ...(meta.name !== undefined ? { name: was!.name } : {}),
        ...(meta.description !== undefined ? { description: was!.description } : {}),
      };
      // Su una bozza: il flusso di prima. Su un'accesa senza bozza il
      // salvataggio ha aperto la bozza della versione dopo: annullare la toglie.
      return onAutomation(
        a,
        was!.draft
          ? { fn: "saveAutomationDraft", args: { id, flow: was!.flow, meta: metaWas } }
          : { fn: "deleteAutomationDraft", args: { id } },
      );
    },
  },
  deleteAutomationDraft: {
    apiFn: "automations.deleteDraft",
    baseClass: "B",
    undoable: false,
    whoAction: "manageProjectAutomations",
    run(me, args) {
      const id = args.id as string;
      const a = state.automations.find((x) => x.id === id);
      deleteDraftAs(me, id);
      return onAutomation(a!, null);
    },
  },

  // --- il filtro salvato personale (area 10b, Task 9) ------------------------
  // Tocca solo chi chiede: nessun permesso, quindi nessun «Who?» (P4). Dal
  // riquadro nasce solo privato: un filtro pubblico lo vedrebbero gli altri.
  saveFilter: {
    apiFn: "saveFilter",
    baseClass: "A",
    undoable: true,
    whoAction: null,
    run(me, args) {
      if ((args.visibility ?? "private") !== "private") throw invalid("visibility");
      const criteria = parseCriteria(args.criteria);
      if (criteria === null) throw invalid("criteria");
      const view = (TASK_VIEWS as readonly unknown[]).includes(args.view)
        ? (args.view as TaskView)
        : "list";
      const groupBy = (GROUP_BYS as readonly unknown[]).includes(args.groupBy)
        ? (args.groupBy as GroupBy)
        : "status";
      const filter = saveFilterAs(me, {
        name: typeof args.name === "string" ? args.name : "",
        visibility: "private",
        criteria,
        view,
        groupBy,
      });
      return onFilter(filter.id, { fn: "deleteFilter", args: { id: filter.id } });
    },
  },
  deleteFilter: {
    apiFn: "deleteFilter",
    baseClass: "B",
    undoable: false,
    whoAction: null,
    run(me, args) {
      const id = args.id as string;
      deleteFilterAs(me, id);
      return onFilter(id, null);
    },
  },

  ...PRODUCT_ENTRIES,
};
