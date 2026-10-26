import { useCallback, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { stepAt, visitSteps } from "../../../domain/automations/fields";
import type { AutomationFlow, AutomationSourceView, Step } from "../../../data/types";
import { useToast } from "../../../tasks-ui/Toast";
import type { BuilderState } from "./context";
import {
  brokenBy,
  duplicateAt,
  freshId,
  innerCount,
  insertAt,
  moveByOne,
  moveTo,
  newStep,
  pathsById,
  placeOf,
  removeAt,
  stepNumbers,
  type DropTarget,
} from "./tree";

// Le azioni del costruttore sul flusso: selezionare, rivelare un passo,
// aggiungere, spostare, duplicare, eliminare (con Undo), andare al problema
// successivo. Le operazioni sono quelle pure di `tree.ts`; qui si legano
// alla selezione, al fuoco e agli annunci.

export interface Adding {
  lane: string;
  index: number;
  anchor: HTMLElement | null;
}

export interface Deleting {
  id: string;
  inside: number;
  broken: number[];
}

export function useBuilderActions(o: {
  flow: AutomationFlow;
  update: BuilderState["update"];
  paths: Map<string, string>;
  numbers: Map<string, number>;
  sources: AutomationSourceView[];
  general: boolean;
  issues: BuilderState["issues"];
  selected: string | null;
  setSelected: (id: string | null) => void;
  setPanelOpen: (open: boolean) => void;
  announce: (text: string) => void;
  collapsed: Set<string>;
  writeCollapsed: (next: Set<string>) => void;
  treeRef: RefObject<HTMLUListElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  dataRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { flow, update, paths, numbers, announce, setSelected, setPanelOpen } = o;
  const [adding, setAdding] = useState<Adding | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [movingTo, setMovingTo] = useState<string | null>(null);

  const focusPanel = () =>
    requestAnimationFrame(() =>
      o.panelRef.current
        ?.querySelector<HTMLElement>(
          "input, select, textarea, [contenteditable='true'], button[role='radio']",
        )
        ?.focus(),
    );

  const reveal = (id: string) => {
    const path = paths.get(id);
    if (!path) return;
    // Apre i blocchi che contengono il passo.
    const opened = new Set(o.collapsed);
    let changed = false;
    for (const [other, p] of paths) {
      if (path.startsWith(`${p}/`) && opened.delete(other)) changed = true;
    }
    if (changed) o.writeCollapsed(opened);
    requestAnimationFrame(() => {
      const row = o.treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${id}"]`);
      row?.scrollIntoView?.({ block: "nearest" });
      row?.focus();
    });
  };

  const select = useCallback((id: string | null, opts: { focusPanel?: boolean } = {}) => {
    setSelected(id);
    setPanelOpen(true);
    if (opts.focusPanel) {
      if (id === "trigger") requestAnimationFrame(() => o.dataRef.current?.focus());
      else focusPanel();
    }
  }, []);

  const move = (id: string, dir: -1 | 1) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const r = moveByOne(flow.steps, path, dir);
    if (!r) {
      announce(t(dir < 0 ? "automations.builder.move.atTop" : "automations.builder.move.atBottom"));
      return;
    }
    update((f) => ({ ...f, steps: r.steps }));
    const { lane, index } = placeOf(r.path);
    const blockPath = lane.split("/").slice(0, -1).join("/");
    announce(
      lane === ""
        ? t("automations.builder.move.movedMain", { position: index + 1 })
        : t("automations.builder.move.movedLane", {
            position: index + 1,
            n: stepNumbers(r.steps).get(blockPath),
          }),
    );
  };

  const focusId = (id: string) =>
    requestAnimationFrame(() =>
      o.treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${id}"]`)?.focus(),
    );

  /**
   * Dove va il fuoco togliendo una riga: la riga che viene dopo (fuori dal
   * blocco che sparisce), altrimenti quella prima, altrimenti «When».
   */
  const neighbourOf = (id: string): string => {
    const rows = [...(o.treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])];
    const gone = rows.find((r) => r.dataset.treeRow === id);
    if (!gone) return "trigger";
    const at = rows.indexOf(gone);
    const after = rows.slice(at + 1).find((r) => !gone.contains(r));
    const before = rows.slice(0, at).at(-1);
    return (after ?? before)?.dataset.treeRow ?? "trigger";
  };

  /**
   * Elimina il passo; «Undo» lo rimette nella sua corsia, al suo posto,
   * nel flusso di ADESSO (le modifiche fatte nel frattempo restano). Se la
   * corsia non c'è più, torna in fondo ai passi principali.
   */
  const applyDelete = (id: string) => {
    const path = paths.get(id);
    if (path === undefined) return;
    // La corsia per blocco (id) e segmento: i percorsi cambiano con le modifiche fatte dopo.
    const place = placeOf(path);
    const segs = place.lane.split("/");
    const seg = segs.pop() ?? "";
    const block = place.lane === "" ? null : (stepAt(flow.steps, segs.join("/"))?.id ?? null);
    const removed = stepAt(flow.steps, path)!;
    const n = numbers.get(path);
    const next = neighbourOf(id);
    update((f) => ({ ...f, steps: removeAt(f.steps, pathsById(f.steps).get(id) ?? path).steps }));
    setSelected(null);
    focusId(next);
    announce(t("automations.builder.deleted", { n }));
    toast.show(t("automations.builder.deleted", { n }), {
      action: {
        label: t("automations.builder.undo"),
        run: () => {
          update((f) => {
            const blockPath = block === null ? "" : pathsById(f.steps).get(block);
            const lane =
              blockPath === undefined ? null : block === null ? "" : `${blockPath}/${seg}`;
            try {
              if (lane === null) throw new Error("lane gone");
              return { ...f, steps: insertAt(f.steps, lane, place.index, removed) };
            } catch {
              return { ...f, steps: [...f.steps, removed] };
            }
          });
          announce(t("automations.builder.restored", { n }));
          focusId(removed.id);
        },
      },
    });
  };

  const requestDelete = (id: string) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const { steps, removed } = removeAt(flow.steps, path);
    const after = { ...flow, steps };
    const afterNumbers = stepNumbers(steps);
    const afterPaths = pathsById(steps);
    const broken = brokenBy(flow, after, o.sources).map(
      (x) => afterNumbers.get(afterPaths.get(x)!)!,
    );
    const inside = innerCount(removed);
    if (inside > 0 || broken.length > 0) setDeleting({ id, inside, broken });
    else applyDelete(id);
  };

  const duplicate = (id: string) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const r = duplicateAt(flow.steps, path, t("automations.builder.copySuffix"));
    const copy = stepAt(r.steps, r.path)!;
    update((f) => ({ ...f, steps: r.steps }));
    setSelected(copy.id);
    announce(t("automations.builder.duplicated", { n: stepNumbers(r.steps).get(r.path) }));
    requestAnimationFrame(() =>
      o.treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${copy.id}"]`)?.focus(),
    );
  };

  const addStep = (kind: Step["kind"]) => {
    if (!adding) return;
    const id = freshId(flow.steps);
    const step = newStep(kind, id, o.general);
    const steps = insertAt(flow.steps, adding.lane, adding.index, step);
    update((f) => ({ ...f, steps }));
    setAdding(null);
    setSelected(id);
    setPanelOpen(true);
    announce(
      t("automations.builder.added", {
        n: stepNumbers(steps).get(`${adding.lane ? `${adding.lane}/` : ""}${adding.index}`),
        kind: t(`automations.builder.kind.${kind}`),
      }),
    );
    focusPanel();
  };

  const applyMoveTo = (id: string, target: DropTarget) => {
    const r = moveTo(flow.steps, paths.get(id)!, target);
    if (r) {
      update((f) => ({ ...f, steps: r.steps }));
      announce(t("automations.builder.move.moved", { n: stepNumbers(r.steps).get(r.path) }));
      reveal(id);
    }
    setMovingTo(null);
  };

  // Il prossimo problema (contatore, F8 / Maiusc+F8, [A 10]): nell'ordine di lettura.
  const problemTargets = useMemo(() => {
    const out: string[] = [];
    if (o.issues.start.length > 0) out.push("trigger");
    visitSteps(flow.steps, (s) => {
      if (o.issues.byStep.has(s.id)) out.push(s.id);
    });
    return out;
  }, [o.issues, flow.steps]);
  const goProblem = (dir: 1 | -1) => {
    if (problemTargets.length === 0) return;
    const at = o.selected ? problemTargets.indexOf(o.selected) : -1;
    const next =
      problemTargets[
        at < 0
          ? dir > 0
            ? 0
            : problemTargets.length - 1
          : (at + dir + problemTargets.length) % problemTargets.length
      ]!;
    select(next);
    if (next === "trigger")
      requestAnimationFrame(() =>
        o.treeRef.current?.querySelector<HTMLElement>('[data-tree-row="trigger"]')?.focus(),
      );
    else reveal(next);
  };

  return {
    adding,
    setAdding,
    deleting,
    setDeleting,
    movingTo,
    setMovingTo,
    select,
    reveal,
    move,
    applyDelete,
    requestDelete,
    duplicate,
    addStep,
    applyMoveTo,
    goProblem,
  };
}
