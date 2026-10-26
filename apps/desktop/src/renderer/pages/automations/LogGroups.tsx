import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RunLogEntry, Step } from "../../data/types";
import { stepSentence, templatePlain } from "./format";
import { Disclosure, StepGlyph } from "./glyphs";
import { type LogCtx } from "./LogEntryText";
import { containerEntries, created, isProblem, type LogContainer } from "./logTree";

// I pezzi dei gruppi del registro: il contenuto chiuso ma cercabile
// (`hidden="until-found"`), il rientro, le etichette dei rami, i rami non presi.

export type LogFilter = "all" | "problems" | "created";

export interface View {
  ctx: LogCtx;
  filter: LogFilter;
  showData: boolean;
  isOpen(key: string, fallback: boolean): boolean;
  toggle(key: string, fallback: boolean): void;
  /** La riga fallita su cui si offrono «Skip» e «Retry». */
  actionsFor(entry: RunLogEntry): ReactNode;
  /** La posizione della riga nel registro (per `[`/`]` e le approvazioni con modifiche). */
  indexOf(entry: RunLogEntry): number;
  /** È l'ultima riga del suo passo (la riga «Now»). */
  isLast(entry: RunLogEntry): boolean;
  /** Prima di questa riga cambia il giorno (separatore). */
  dayBreak(entry: RunLogEntry): boolean;
}

export const matches = (filter: LogFilter, entries: RunLogEntry[]) =>
  filter === "all" || (filter === "problems" ? entries.some(isProblem) : entries.some(created));

/** Il contenuto di un gruppo: nel DOM anche chiuso (⌘F lo trova), aperto da `beforematch`. */
export function Collapsible({
  open,
  onFound,
  children,
  id,
}: {
  open: boolean;
  onFound: () => void;
  children: ReactNode;
  id: string;
}) {
  const ref = useRef<HTMLOListElement>(null);
  // React tratta `hidden` come booleano: «until-found» si scrive a mano, prima del disegno.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "until-found");
  }, [open]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("beforematch", onFound);
    return () => el.removeEventListener("beforematch", onFound);
  }, [onFound]);
  return (
    <ol id={id} ref={ref} className="flex flex-col">
      {children}
    </ol>
  );
}

/** Il rientro di un livello (ramo, giro): dopo la colonna dell'ora, che resta allineata. */
export const INDENT = 20;
export const Indent = ({ depth }: { depth: number }) =>
  depth > 0 ? (
    <span aria-hidden="true" className="shrink-0" style={{ width: depth * INDENT }} />
  ) : null;

/** Il nome dell'elemento di un giro, dal suo campo titolo (o la prima riga con un titolo). */
export function roundTitle(c: LogContainer, items: unknown[] | undefined, i: number): string {
  const item = items?.[i] as Record<string, unknown> | undefined;
  const fromItem =
    item &&
    (item.titolo ??
      item.nome ??
      item.title ??
      Object.values(item).find((v) => typeof v === "string"));
  if (typeof fromItem === "string") return fromItem;
  const e = containerEntries(c).find(
    (x) => typeof x.input.titolo === "string" || typeof x.input.nome === "string",
  );
  return String(e?.input.titolo ?? e?.input.nome ?? "");
}

/** Un ramo non preso: riga sbiadita, espandibile per vedere i passi scartati ([A 18]). */
export function NotTaken({
  label,
  steps,
  view,
  keyPath,
  depth,
}: {
  label: string;
  steps: Step[];
  view: View;
  keyPath: string;
  depth: number;
}) {
  const { t } = useTranslation();
  const open = view.isOpen(keyPath, false);
  const ctx = view.ctx;
  return (
    <li data-not-taken className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => view.toggle(keyPath, false)}
        style={{ paddingLeft: 92 + depth * INDENT }}
        className="flex min-h-8 items-center gap-2 rounded-md text-left text-sm text-ink-faint hover:bg-ink/6"
      >
        <Disclosure open={open} />
        {t("automations.log.notTaken", { label, count: steps.length })}
      </button>
      {open && (
        <ol style={{ paddingLeft: 116 + depth * INDENT }}>
          {steps.map((s) => {
            const sentence = stepSentence(
              s,
              ctx.run.flow,
              ctx.names,
              ctx.labels,
              t,
              ctx.automationCode,
            );
            return (
              <li key={s.id} className="flex items-start gap-2 py-1 text-sm text-ink-faint">
                <StepGlyph kind={s.kind} />
                {templatePlain(sentence.text, ctx.labels)}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

export function Indented({
  label,
  depth,
  children,
}: {
  label: string;
  depth: number;
  children: ReactNode;
}) {
  return (
    <li data-log-branch className="flex flex-col">
      <p
        style={{ paddingLeft: 92 + depth * INDENT }}
        className="pt-1.5 pb-0.5 text-xs font-semibold text-ink-muted"
      >
        {label}
      </p>
      <ol className="flex flex-col">{children}</ol>
    </li>
  );
}

export function branchLabel(
  step: Step | null,
  seg: string,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  if (!step) return seg;
  if (step.kind === "condition") {
    return seg === "then" ? t("automations.branch.yes") : t("automations.branch.otherwise");
  }
  if (step.kind === "claude") return t("automations.branch.claude", { outcome: seg });
  if (step.kind === "repeatUntil" && seg === "onLimit")
    return t("automations.branch.onLimitFollowed");
  return seg;
}
