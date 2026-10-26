import {
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useBuilder } from "./context";
import { moveTo, stepNumbers, type DropTarget } from "./tree";

// Il trascinamento col puntatore (shape builder §6): dnd-kit come la Home,
// la maniglia a sei punti, la linea d'inserimento sopra o sotto la riga (o
// in testa al «+ Add a step» di una corsia), anche dentro e fuori dalle
// corsie; mai dentro sé stesso né oltre il quinto livello (`moveTo`).

export interface Indicator {
  key: string;
  edge: "top" | "bottom";
  target: DropTarget;
}

export function useTreeDrag(where: (id: string) => string) {
  const { t } = useTranslation();
  const b = useBuilder();
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragMove = ({ active, over, activatorEvent, delta }: DragMoveEvent) => {
    if (!over) return setIndicator(null);
    const key = String(over.id);
    const y = (activatorEvent as PointerEvent).clientY + delta.y;
    if (key.startsWith("lane:")) {
      const { block, seg } = over.data.current as { block: string | null; seg: string };
      return setIndicator({ key, edge: "top", target: { block, seg } });
    }
    const id = key.slice("row:".length);
    if (id === String(active.id)) return setIndicator(null);
    const before = y < over.rect.top + over.rect.height / 2;
    setIndicator({
      key,
      edge: before ? "top" : "bottom",
      target: before ? { before: id } : { after: id },
    });
  };

  const onDragEnd = ({ active }: DragEndEvent) => {
    const id = String(active.id);
    const target = indicator?.target;
    setIndicator(null);
    const path = b.paths.get(id);
    if (!target || path === undefined) return;
    const r = moveTo(b.flow.steps, path, target);
    if (!r) {
      b.announce(t("automations.builder.move.notThere"));
      return;
    }
    b.update((f) => ({ ...f, steps: r.steps }));
    // Il numero di arrivo, non quello di partenza.
    b.announce(t("automations.builder.move.moved", { n: stepNumbers(r.steps).get(r.path) ?? "" }));
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("automations.builder.move.picked", {
        n: b.numbers.get(b.paths.get(String(active.id)) ?? "") ?? "",
        where: where(String(active.id)),
      }),
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => t("automations.builder.move.cancelled"),
  };

  return {
    indicator,
    sensors,
    onDragMove,
    onDragEnd,
    onDragCancel: () => setIndicator(null),
    announcements,
  };
}
