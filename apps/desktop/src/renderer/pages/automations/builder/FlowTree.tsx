import { DndContext, pointerWithin } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { CriticalGlyph } from "../glyphs";
import { useBuilder } from "./context";
import { AddRow, StartRow, StepRow, type RowCtx } from "./FlowRows";
import { useTreeDrag } from "./useTreeDrag";
import { useTreeKeyboard } from "./useTreeKeyboard";

// Il flusso come procedura scritta (shape builder §3, [A 3]): un elenco
// numerato verticale, l'inizio in testa, i rami come corsie rientrate di
// 20px con la loro etichetta in parole e il «+ Add a step» sempre visibile.
// È un `role="tree"` (tastiera in `useTreeKeyboard`); col puntatore la
// maniglia a sei punti (`useTreeDrag`). Le righe stanno in `FlowRows`.

export function FlowTree({ treeRef }: { treeRef: React.RefObject<HTMLUListElement | null> }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const keys = useTreeKeyboard(treeRef);
  const drag = useTreeDrag(keys.where);

  const ctx: RowCtx = {
    focusId: keys.focusId,
    setFocusId: keys.setFocusId,
    picked: keys.picked,
    indicator: drag.indicator,
    onKey: keys.onKey,
    onBlur: keys.onBlur,
  };

  return (
    <DndContext
      sensors={drag.sensors}
      collisionDetection={pointerWithin}
      onDragMove={drag.onDragMove}
      onDragEnd={drag.onDragEnd}
      onDragCancel={drag.onDragCancel}
      accessibility={{
        announcements: drag.announcements,
        screenReaderInstructions: { draggable: t("automations.builder.move.instructions") },
      }}
    >
      <ul
        ref={treeRef}
        role="tree"
        aria-label={t("automations.builder.flowLabel")}
        aria-describedby="builder-tree-help"
        className="flex flex-col"
      >
        <StartRow ctx={ctx} />
        {b.flow.steps.map((s, i) => (
          <StepRow key={s.id} step={s} path={String(i)} depth={0} ctx={ctx} />
        ))}
        <AddRow lane="" block={null} seg="" index={b.flow.steps.length} depth={0} ctx={ctx} main />
        {b.flow.steps.length === 0 && (
          <li role="none" className="pl-11 text-sm text-ink-muted">
            {t("automations.builder.emptyHint")}
          </li>
        )}
        {b.issues.flow.length > 0 && b.flow.steps.length === 0 && (
          <li role="none" className="flex items-center gap-1.5 pl-11 text-sm text-critical">
            <CriticalGlyph />
            {t("automations.builder.problem.noSteps")}
          </li>
        )}
        <li role="none" className="flex h-10 items-center pl-11 text-sm text-ink-faint">
          {t("automations.builder.end")}
        </li>
      </ul>
      <p id="builder-tree-help" className="sr-only">
        {t("automations.builder.treeHelp")}
      </p>
    </DndContext>
  );
}
