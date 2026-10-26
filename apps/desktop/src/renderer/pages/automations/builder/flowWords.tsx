import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { childLists } from "../../../domain/automations/fields";
import type { Approval, Step } from "../../../data/types";
import { conditionWords, templateParts } from "../format";
import { useBuilder, type BuilderState } from "./context";
import { tokenLabel } from "./DataText";
import { producerOf } from "./issues";

// Le parole delle righe del flusso: chi approva, l'etichetta di una corsia,
// il progetto del passo, i gettoni dei dati (barrati se qui non ci sono).

/** «Asks Laura Costa» / «Asks the Project Lead» / «Asks the owner»; null se parte da solo ([A 5]). */
export function asksWords(approval: Approval, b: BuilderState, t: TFunction) {
  if (approval.mode !== "ask") return null;
  const who = approval.who;
  if ("owner" in who) return t("automations.builder.asks.owner");
  if ("personId" in who)
    return who.personId
      ? t("automations.builder.asks.person", { name: b.names.person(who.personId) })
      : t("automations.builder.asks.nobody");
  return t("automations.builder.asks.role", {
    role: t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole }),
  });
}

/** L'etichetta di una corsia, in parole. */
export function laneLabel(step: Step, seg: string, b: BuilderState, t: TFunction) {
  switch (step.kind) {
    case "condition":
      return seg === "then"
        ? t("automations.builder.lane.if", {
            when: conditionWords(step.when, b.labels, t as never),
          })
        : t("automations.builder.lane.otherwise");
    case "claude":
      return t("automations.builder.lane.claude", { outcome: seg });
    case "forEach":
      return t("automations.builder.lane.forEach", {
        as: step.as || t("automations.builder.lane.item"),
        list: step.list ? tokenLabel(b.flow, step.list, b.labels) : "…",
      });
    case "repeatUntil":
      return seg === "onLimit"
        ? t("automations.builder.lane.onLimit")
        : t("automations.builder.lane.repeat", {
            until: conditionWords(step.until, b.labels, t as never),
            count: step.max,
          });
    default:
      return seg;
  }
}

/** Un testo con i dati come gettoni; un dato che qui non c'è è barrato, col perché. */
export function Tokens({ text, available }: { text: string; available: Set<string> }) {
  const { t } = useTranslation();
  const b = useBuilder();
  return (
    <>
      {templateParts(text, b.labels).map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        const ok = available.has(p.ref);
        const from = ok ? null : producerOf(b.flow, p.ref);
        const n = from ? b.numbers.get(from.path) : undefined;
        return (
          <span
            key={i}
            data-token={p.ref}
            data-unavailable={ok ? undefined : ""}
            title={
              ok
                ? undefined
                : n !== undefined
                  ? t("automations.builder.data.laterOrElsewhere", { n })
                  : t("automations.builder.data.gone")
            }
            className={`rounded-[4px] px-1 ${ok ? "bg-ink/6" : "bg-critical/10 text-critical line-through decoration-critical"}`}
          >
            {tokenLabel(b.flow, p.ref, b.labels)}
          </span>
        );
      })}
    </>
  );
}

export function findById(b: BuilderState, id: string): Step | null {
  const path = b.paths.get(id);
  return path === undefined ? null : findByPath(b, path);
}

export function findByPath(b: BuilderState, path: string): Step | null {
  let list: Step[] = b.flow.steps;
  let step: Step | null = null;
  const segs = path.split("/");
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!;
    if (/^\d+$/.test(seg)) {
      step = list[Number(seg)] ?? null;
      if (!step) return null;
    } else {
      const child = childLists(step!).find((c) => c.seg === seg);
      if (!child) return null;
      list = child.steps;
    }
  }
  return step;
}

export function countInside(step: Step, b: BuilderState): number {
  let n = 0;
  for (const c of childLists(step))
    for (const s of c.steps) {
      n += b.issues.byStep.get(s.id)?.length ?? 0;
      n += countInside(s, b);
    }
  return n;
}

export function automationCode(b: BuilderState, id: string): string | null {
  return b.otherAutomations.find((a) => a.id === id)?.code ?? null;
}

export function projectMark(step: Step, b: BuilderState, t: TFunction) {
  if (!("project" in step)) return null;
  const p = step.project;
  if (p.mode === "own") return null;
  if (p.mode === "from_client") {
    if (b.automation.projectId === null) return null;
    return { text: t("automations.steps.inClientProject"), title: undefined };
  }
  const prj = b.names.project(p.projectId);
  if (!prj)
    return p.projectId ? { text: t("automations.steps.inHiddenProject"), title: undefined } : null;
  return {
    text: t("automations.steps.inProject", { code: prj.code }),
    title: `${prj.code} · ${prj.name}`,
  };
}
