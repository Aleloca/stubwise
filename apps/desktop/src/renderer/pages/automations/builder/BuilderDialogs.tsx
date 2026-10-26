import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { childLists, joinPath, stepAt, visitSteps } from "../../../domain/automations/fields";
import type { Step } from "../../../data/types";
import { Dialog, DialogField } from "../../../tasks-ui/Dialog";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { useBuilder } from "./context";
import { laneLabel } from "./flowWords";
import { selectClass } from "./controls";
import { fits, laneDepth, type DropTarget } from "./tree";

// I dialoghi del costruttore: eliminare un blocco con passi dentro (o un
// passo i cui dati servono ad altri) e «Move to…» con l'albero delle corsie
// e la posizione ([A 13]).

export function DeleteStepDialog({
  step,
  inside,
  broken,
  onConfirm,
  onClose,
}: {
  step: Step;
  inside: number;
  /** I numeri dei passi che perderebbero un dato. */
  broken: number[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const n = b.numbers.get(b.paths.get(step.id) ?? "") ?? 0;
  return (
    <Dialog
      title={
        inside > 0
          ? t("automations.builder.delete.blockTitle", { n, count: inside })
          : t("automations.builder.delete.title", { n })
      }
      width={460}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button type="button" data-autofocus className={dangerSolidButton} onClick={onConfirm}>
            {t("automations.actions.delete")}
          </button>
        </>
      }
    >
      {broken.length > 0 && (
        <p data-delete-broken className="text-md text-ink">
          {t("automations.builder.delete.broken", {
            count: broken.length,
            steps: broken.join(", "),
          })}
        </p>
      )}
      {broken.length === 0 && (
        <p className="text-md text-ink-muted">{t("automations.builder.delete.undo")}</p>
      )}
    </Dialog>
  );
}

interface LaneChoice {
  key: string;
  label: string;
  block: string | null;
  seg: string;
  steps: Step[];
}

export function MoveToDialog({
  step,
  onMove,
  onClose,
}: {
  step: Step;
  onMove: (target: DropTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const laneId = useId();
  const posId = useId();
  const inside = new Set<string>();
  visitSteps([step], (s) => inside.add(s.id));
  const lanes: LaneChoice[] = [
    {
      key: "main",
      label: t("automations.builder.moveTo.main"),
      block: null,
      seg: "",
      steps: b.flow.steps,
    },
  ];
  visitSteps(b.flow.steps, (s, path) => {
    if (inside.has(s.id)) return;
    for (const c of childLists(s)) {
      const lane = joinPath(path, c.seg);
      if (!fits(step, laneDepth(lane))) continue;
      lanes.push({
        key: lane,
        label: t("automations.builder.moveTo.lane", {
          n: b.numbers.get(path),
          lane: laneLabel(s, c.seg, b, t),
        }),
        block: s.id,
        seg: c.seg,
        steps: c.steps,
      });
    }
  });
  const here = b.paths.get(step.id) ?? "0";
  const hereLane = here.split("/").slice(0, -1).join("/");
  const [lane, setLane] = useState(
    lanes.find((l) => l.key === (hereLane || "main"))?.key ?? "main",
  );
  const chosen = lanes.find((l) => l.key === lane) ?? lanes[0]!;
  const others = chosen.steps.filter((s) => s.id !== step.id);
  const [pos, setPos] = useState("start");
  const target = (): DropTarget =>
    pos === "start" ? { block: chosen.block, seg: chosen.seg, index: 0 } : { after: pos };
  const n = b.numbers.get(here) ?? 0;
  return (
    <Dialog
      title={t("automations.builder.moveTo.title", { n })}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={() => onMove(target())}>
            {t("automations.builder.moveTo.move")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.builder.moveTo.where")} htmlFor={laneId}>
        <select
          id={laneId}
          data-autofocus
          className={`${selectClass} w-full`}
          value={lane}
          onChange={(e) => {
            setLane(e.target.value);
            setPos("start");
          }}
        >
          {lanes.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      </DialogField>
      <DialogField label={t("automations.builder.moveTo.position")} htmlFor={posId}>
        <select
          id={posId}
          className={`${selectClass} w-full`}
          value={pos}
          onChange={(e) => setPos(e.target.value)}
        >
          <option value="start">{t("automations.builder.moveTo.first")}</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {t("automations.builder.moveTo.after", { n: b.numbers.get(b.paths.get(s.id) ?? "") })}
            </option>
          ))}
        </select>
      </DialogField>
    </Dialog>
  );
}

/** Il passo per id, nell'albero di adesso. */
export function stepById(steps: Step[], paths: Map<string, string>, id: string): Step | null {
  const path = paths.get(id);
  return path === undefined ? null : stepAt(steps, path);
}
