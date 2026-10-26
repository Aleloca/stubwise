import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { inputClass } from "../../../tasks-ui/Dialog";
import { useTest } from "./context";
import { roundOutcome, roundTitle } from "./words";

// Il selettore del giro di un ciclo (shape automation-test §5, «I giri»
// [A 11]): «Round 3 of 6 · task: Configure CRM users» con ‹ ›, e «All
// rounds», un elenco compatto e virtualizzato con la ricerca: con 50 giri
// resta leggibile. I passi della corsia mostrano i segni del giro scelto.

const ROW = 32;
const VIEW = 320;

export function RoundPicker({
  blockPath,
  kind,
  total,
  max,
  stepNumber,
}: {
  blockPath: string;
  kind: "forEach" | "repeat";
  /** Quanti giri ha (gli elementi di un «Per ogni», i giri fatti di un «Ripeti finché»). */
  total: number;
  /** «Ripeti finché»: al massimo quanti. */
  max?: number;
  stepNumber: number;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const round = Math.min(ctx.roundOf(blockPath), Math.max(total - 1, 0));
  const [open, setOpen] = useState(false);
  const allRef = useRef<HTMLButtonElement>(null);
  const title = roundTitle(ctx, blockPath, round);
  const go = (r: number) => ctx.setRound(blockPath, Math.max(0, Math.min(total - 1, r)));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      go(round - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      go(round + 1);
    }
  };
  if (total === 0) return null;
  const label =
    max !== undefined
      ? t("automations.test.rounds.ofMax", { n: round + 1, total: max })
      : t("automations.test.rounds.of", { n: round + 1, total });
  return (
    <div
      role="group"
      aria-label={t("automations.test.rounds.label", { n: stepNumber })}
      data-round-picker={blockPath}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
      className="relative flex min-w-0 flex-wrap items-center gap-1 text-xs"
    >
      <button
        type="button"
        aria-label={t("automations.test.rounds.prev")}
        disabled={round === 0}
        onClick={() => go(round - 1)}
        className="grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink disabled:opacity-30"
      >
        <Arrow dir="left" />
      </button>
      <span aria-live="polite" data-round-label className="min-w-0 truncate font-semibold text-ink">
        <span className="num">{label}</span>
        {title && <span className="font-normal text-ink-muted"> · {title}</span>}
      </span>
      <button
        type="button"
        aria-label={t("automations.test.rounds.next")}
        disabled={round >= total - 1}
        onClick={() => go(round + 1)}
        className="grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink disabled:opacity-30"
      >
        <Arrow dir="right" />
      </button>
      {total > 1 && (
        <button
          ref={allRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          className="ml-1 h-6 rounded-md px-1.5 font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {t("automations.test.rounds.all")}
        </button>
      )}
      {open && (
        <AllRounds
          blockPath={blockPath}
          kind={kind}
          total={total}
          current={round}
          onPick={(r) => {
            go(r);
            setOpen(false);
            allRef.current?.focus();
          }}
          onClose={() => {
            setOpen(false);
            allRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function AllRounds({
  blockPath,
  kind,
  total,
  current,
  onPick,
  onClose,
}: {
  blockPath: string;
  kind: "forEach" | "repeat";
  total: number;
  current: number;
  onPick: (round: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const [q, setQ] = useState("");
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(VIEW);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const rows = useMemo(
    () =>
      Array.from({ length: total }, (_, i) => ({
        i,
        title: roundTitle(ctx, blockPath, i),
        outcome: roundOutcome(ctx, blockPath, kind, i, t),
      })),
    [ctx, blockPath, kind, total, t],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => String(r.i + 1) === needle || r.title.toLowerCase().includes(needle))
    : rows;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && el.clientHeight > 0) setHeight(el.clientHeight);
    // Il giro scelto si vede subito.
    if (el && !needle) el.scrollTop = Math.max(0, current * ROW - ROW * 2);
  }, []);
  // Solo le righe visibili, più un margine: con 50 giri il DOM resta piccolo.
  const first = Math.max(0, Math.floor(scroll / ROW) - 4);
  const last = Math.min(shown.length, Math.ceil((scroll + height) / ROW) + 4);
  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      data-all-rounds
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="menu-enter absolute top-full left-0 z-30 mt-1 flex w-[400px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-lg border border-rule-strong bg-surface p-2 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <p id={titleId} className="heading-group px-1 pt-1">
        {t("automations.test.rounds.all")}
      </p>
      <input
        type="search"
        autoFocus
        aria-label={t("automations.test.rounds.find")}
        placeholder={t("automations.test.rounds.find")}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setScroll(0);
          if (listRef.current) listRef.current.scrollTop = 0;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) {
            e.preventDefault();
            onPick(shown[0].i);
          }
        }}
        className={`${inputClass} h-8`}
      />
      <div
        ref={listRef}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        className="relative max-h-[320px] overflow-y-auto"
      >
        {shown.length === 0 ? (
          <p className="px-2 py-2 text-sm text-ink-muted">{t("automations.test.rounds.none")}</p>
        ) : (
          <ul
            aria-label={t("automations.test.rounds.all")}
            data-round-count={shown.length}
            style={{ height: shown.length * ROW }}
            className="relative"
          >
            {shown.slice(first, last).map((r, k) => (
              <li
                key={r.i}
                style={{ top: (first + k) * ROW, height: ROW }}
                className="absolute right-0 left-0"
              >
                <button
                  type="button"
                  data-round-row={r.i}
                  aria-current={r.i === current ? "true" : undefined}
                  onClick={() => onPick(r.i)}
                  className={`flex h-full w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-ink/6 ${r.i === current ? "bg-ink/10" : ""}`}
                >
                  <span className="num w-6 shrink-0 text-right text-ink-faint">{r.i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {r.title || t("automations.test.rounds.item", { n: r.i + 1 })}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{r.outcome}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "m10 4-4 4 4 4" : "m6 4 4 4-4 4"} />
    </svg>
  );
}
