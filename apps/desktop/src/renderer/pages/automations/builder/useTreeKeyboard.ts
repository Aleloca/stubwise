import { useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useBuilder, type BuilderState } from "./context";
import { findById, findByPath, laneLabel } from "./flowWords";
import { hasLanes, placeOf } from "./tree";

// La tastiera del flusso (shape builder [A 13], [A 14]): un `role="tree"`
// con fuoco itinerante. ↑/↓ fra le righe, → apre/entra, ← chiude/esce,
// Enter seleziona; Spazio prende il passo, ↑/↓ lo spostano nell'ordine di
// lettura, Spazio lascia, Esc lo rimette dov'era; A aggiunge dopo, ⌘D
// duplica, ⌫ elimina, ⌥↑/⌥↓ spostano di uno.

export const ROW = "[data-tree-row]";

export function focusRow(tree: HTMLElement | null, id: string) {
  requestAnimationFrame(() =>
    tree?.querySelector<HTMLElement>(`${ROW}[data-tree-row="${id}"]`)?.focus(),
  );
}

export function useTreeKeyboard(treeRef: RefObject<HTMLUListElement | null>) {
  const { t } = useTranslation();
  const b = useBuilder();
  const [focusId, setFocusId] = useState<string>("trigger");
  const [picked, setPicked] = useState<{ id: string; original: BuilderState["flow"] } | null>(null);

  const say = (key: string, id: string, extra: object = {}) => {
    const path = b.paths.get(id);
    b.announce(t(key, { n: path ? b.numbers.get(path) : "", ...extra }));
  };

  /** Dove sta un passo, in parole: «at position 2 in “If Claude says …”». */
  const where = (id: string): string => {
    const path = b.paths.get(id);
    if (path === undefined) return "";
    const { lane, index } = placeOf(path);
    if (lane === "") return t("automations.builder.move.inMain", { position: index + 1 });
    const blockPath = lane.split("/").slice(0, -1).join("/");
    const seg = lane.split("/").at(-1)!;
    const block = blockPath === "" ? null : findByPath(b, blockPath);
    return t("automations.builder.move.inLane", {
      position: index + 1,
      lane: block ? laneLabel(block, seg, b, t) : "",
    });
  };

  const rows = () => [...(treeRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
  const go = (from: HTMLElement, dir: 1 | -1) => {
    const list = rows();
    const next = list[list.indexOf(from) + dir];
    next?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    const step = id === "trigger" ? null : findById(b, id);
    const mod = e.metaKey || e.ctrlKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (picked && picked.id === id) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        handled();
        b.move(id, e.key === "ArrowUp" ? -1 : 1);
        focusRow(treeRef.current, id);
      } else if (e.key === " " || e.key === "Enter") {
        handled();
        setPicked(null);
        b.announce(t("automations.builder.move.dropped", { where: where(id) }));
      } else if (e.key === "Escape") {
        handled();
        b.update(() => picked.original);
        setPicked(null);
        b.announce(t("automations.builder.move.cancelled"));
        focusRow(treeRef.current, id);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (e.altKey && step && !b.readOnly) {
          handled();
          b.move(id, e.key === "ArrowUp" ? -1 : 1);
          focusRow(treeRef.current, id);
          return;
        }
        handled();
        go(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
        return;
      case "ArrowRight":
        if (step && hasLanes(step)) {
          handled();
          if (b.collapsed.has(id)) b.toggleCollapsed(id, true);
          else go(e.currentTarget, 1);
        }
        return;
      case "ArrowLeft": {
        handled();
        if (step && hasLanes(step) && !b.collapsed.has(id)) b.toggleCollapsed(id, false);
        else e.currentTarget.parentElement?.closest<HTMLElement>(ROW)?.focus();
        return;
      }
      case "Enter":
        handled();
        b.select(id);
        return;
    }
    if (!step || b.readOnly) return;
    if (e.key === " ") {
      handled();
      setPicked({ id, original: b.flow });
      say("automations.builder.move.picked", id, { where: where(id) });
    } else if ((e.key === "a" || e.key === "A") && !mod && !e.altKey) {
      handled();
      const { lane, index } = placeOf(b.paths.get(id)!);
      b.requestAdd(lane, index + 1, e.currentTarget);
    } else if (mod && (e.key === "d" || e.key === "D")) {
      handled();
      b.duplicate(id);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      handled();
      b.requestDelete(id);
    }
  };

  /** Uscire dalla riga presa la lascia dov'è (come la Home). */
  const onBlur = (id: string) =>
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.dataset.treeRow === id) return;
      setPicked((p) => (p?.id === id ? null : p));
    });

  return { focusId, setFocusId, picked: picked?.id ?? null, onKey, onBlur, where };
}
