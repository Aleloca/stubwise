import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunLogEntry, Step } from "../../data/types";
import { quietButton } from "../tasks/controls";
import { type LogCtx } from "./LogEntryText";

// Il passo di Claude nel registro (shape [A 1], regola 2): le uscite possibili
// con quella scelta in evidenza, il perché scritto da Claude, i campi restituiti.

/** Il passo di Claude: le uscite possibili con quella scelta, il perché, i campi restituiti. */
export function ClaudeBlock({
  entry,
  step,
  ctx,
}: {
  entry: RunLogEntry;
  step: Step | null;
  ctx: LogCtx;
}) {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);
  const outcomes = step?.kind === "claude" ? step.outcomes : [];
  const chosen = typeof entry.output.uscita === "string" ? entry.output.uscita : null;
  const fields = Object.entries(entry.output).filter(([k]) => k !== "uscita");
  return (
    <div data-claude-block className="mb-2 flex flex-col gap-2 border-l border-rule pl-4">
      {chosen !== null && (
        <p className="text-md text-ink">
          {t("automations.log.claudeChose")} <strong className="font-semibold">{chosen}</strong>
        </p>
      )}
      {outcomes.length > 0 && (
        <p data-outcomes className="flex flex-wrap gap-x-2 text-sm">
          {outcomes.map((o, i) => (
            <span key={o} className={o === chosen ? "font-semibold text-ink" : "text-ink-faint"}>
              {o}
              {i < outcomes.length - 1 && <span className="text-ink-faint"> ·</span>}
            </span>
          ))}
        </p>
      )}
      {entry.reason && (
        <div className="flex flex-col gap-0.5">
          <p className="heading-group">{t("automations.log.why")}</p>
          <p className={`max-w-[72ch] text-md text-ink ${more ? "" : "line-clamp-6"}`}>
            {entry.reason}
          </p>
          {entry.reason.length > 480 && (
            <button
              type="button"
              className="self-start text-sm text-ink underline-offset-4 hover:underline"
              onClick={() => setMore((v) => !v)}
            >
              {more ? t("automations.detail.less") : t("automations.detail.more")}
            </button>
          )}
        </div>
      )}
      {fields.map(([k, v]) => (
        <ReturnedField key={k} name={k} value={v} ctx={ctx} />
      ))}
    </div>
  );
}

/** Un campo restituito da Claude: testo, o un elenco come tabella compatta («Show all 23» oltre 10). */
export function ReturnedField({ name, value, ctx }: { name: string; value: unknown; ctx: LogCtx }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const field = ctx.labels.get(name);
  const label = field?.label ?? name;
  if (Array.isArray(value)) {
    const rows = value as Record<string, unknown>[];
    const cols = field?.of ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k }));
    const shown = all ? rows : rows.slice(0, 10);
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm text-ink-muted">{label}</p>
        <table className="max-w-[640px] text-sm">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="border-b border-rule py-1 pr-4 text-left font-medium text-ink-muted"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className="border-b border-rule py-1 pr-4 text-ink">
                    {String(r?.[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <button
            type="button"
            className={`${quietButton} h-7 self-start px-1.5`}
            onClick={() => setAll((v) => !v)}
          >
            {all
              ? t("automations.log.showFewer")
              : t("automations.log.showAllRows", { count: rows.length })}
          </button>
        )}
      </div>
    );
  }
  return (
    <p className="text-sm">
      <span className="text-ink-muted">{label}: </span>
      <span className="text-ink">{typeof value === "string" ? value : JSON.stringify(value)}</span>
    </p>
  );
}
