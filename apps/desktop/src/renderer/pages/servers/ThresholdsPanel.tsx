import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSetThresholds } from "../../data/queries";
import type { ServerThresholds } from "../../data/types";
import { smallPrimary } from "../task/parts";
import { Part, SavedNote, shortInput } from "./Part";
import { WhoCanLink } from "../../components/WhoCanLink";

// Le soglie (shape servers.md §3, «Thresholds»): in lettura tre frasi a
// chiunque veda il server; in modifica (`monitor.manage`) le stesse frasi
// col numero in un campo (1–100, vuoto = spenta) e i minuti in una riga a
// sé. «Save» si abilita solo con modifiche; «Saved» compare dopo la
// conferma del livello dati e sparisce alla prima modifica.

const METRICS = [
  ["cpu", "cpuPct"],
  ["memory", "memPct"],
  ["disk", "diskPct"],
] as const;

type Draft = Record<"cpuPct" | "memPct" | "diskPct" | "sustainedMinutes", string>;

const draftOf = (t: ServerThresholds): Draft => ({
  cpuPct: t.cpuPct === null ? "" : String(t.cpuPct),
  memPct: t.memPct === null ? "" : String(t.memPct),
  diskPct: t.diskPct === null ? "" : String(t.diskPct),
  sustainedMinutes: String(t.sustainedMinutes),
});

/** Il valore di un campo, o il motivo per cui non va (in parole). */
function parse(draft: Draft): {
  value: ServerThresholds | null;
  errors: Partial<Record<keyof Draft, true>>;
} {
  const errors: Partial<Record<keyof Draft, true>> = {};
  const pct = (k: "cpuPct" | "memPct" | "diskPct") => {
    const raw = draft[k].trim();
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 100) errors[k] = true;
    return n;
  };
  const value = {
    cpuPct: pct("cpuPct"),
    memPct: pct("memPct"),
    diskPct: pct("diskPct"),
    sustainedMinutes: Number(draft.sustainedMinutes.trim()),
  };
  if (
    !Number.isInteger(value.sustainedMinutes) ||
    value.sustainedMinutes < 1 ||
    value.sustainedMinutes > 60
  )
    errors.sustainedMinutes = true;
  return { value: Object.keys(errors).length ? null : value, errors };
}

export function ThresholdsPanel({
  serverCode,
  thresholds,
  canManage,
}: {
  serverCode: string;
  thresholds: ServerThresholds;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Part id="thresholds" title={t("servers.index.thresholds")}>
      {canManage ? (
        <ThresholdsForm serverCode={serverCode} thresholds={thresholds} />
      ) : (
        <div className="flex flex-col gap-2 border-t border-rule pt-3 pl-3">
          <ul className="flex flex-col gap-1.5">
            {METRICS.map(([metric, field]) => (
              <li key={metric} className="text-md text-ink">
                {thresholds[field] === null
                  ? t(`servers.thresholds.off.${metric}`)
                  : t(`servers.thresholds.read.${metric}`, {
                      value: thresholds[field],
                      count: thresholds.sustainedMinutes,
                    })}
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">
            {t("servers.thresholds.readOnly")}{" "}
            <WhoCanLink action="manageMonitor" projectId={null} />
          </p>
        </div>
      )}
    </Part>
  );
}

function ThresholdsForm({
  serverCode,
  thresholds,
}: {
  serverCode: string;
  thresholds: ServerThresholds;
}) {
  const { t } = useTranslation();
  const save = useSetThresholds();
  const ids = { cpuPct: useId(), memPct: useId(), diskPct: useId(), sustainedMinutes: useId() };
  const [draft, setDraft] = useState<Draft>(() => draftOf(thresholds));
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const { value, errors } = parse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(thresholds));
  const edit = (k: keyof Draft, v: string) => {
    setSaved(false);
    setFailed(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const submit = () => {
    if (!value) return;
    save.mutate(
      { code: serverCode, thresholds: value },
      { onSuccess: () => setSaved(true), onError: () => setFailed(true) },
    );
  };
  const field = (k: keyof Draft, max: number) => (
    <input
      id={ids[k]}
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      value={draft[k]}
      aria-invalid={errors[k] ? true : undefined}
      aria-describedby={errors[k] ? `${ids[k]}-error` : undefined}
      placeholder={max === 100 ? t("servers.thresholds.offPlaceholder") : undefined}
      onChange={(e) => edit(k, e.target.value)}
      className={`${shortInput} num mx-1.5 h-8 w-20 text-right`}
    />
  );

  return (
    <form
      className="flex flex-col gap-3 border-t border-rule pt-3 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {METRICS.map(([metric, k]) => (
        <div key={metric} className="flex flex-col gap-1">
          <label htmlFor={ids[k]} className="flex flex-wrap items-center gap-y-1 text-md text-ink">
            {t(`servers.thresholds.edit.${metric}`)}
            {field(k, 100)}
            {t("servers.thresholds.edit.percent")}
          </label>
          {errors[k] && (
            <p id={`${ids[k]}-error`} className="text-sm text-critical">
              {t("servers.thresholds.errors.pct")}
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={ids.sustainedMinutes}
          className="flex flex-wrap items-center gap-y-1 text-md text-ink"
        >
          {t("servers.thresholds.edit.minutesBefore")}
          {field("sustainedMinutes", 60)}
          {t("servers.thresholds.edit.minutesAfter")}
        </label>
        {errors.sustainedMinutes && (
          <p id={`${ids.sustainedMinutes}-error`} className="text-sm text-critical">
            {t("servers.thresholds.errors.minutes")}
          </p>
        )}
      </div>
      <p className="text-xs text-ink-muted">{t("servers.thresholds.offHint")}</p>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || !value || save.isPending}
          className={smallPrimary}
        >
          {t("servers.save")}
        </button>
        <SavedNote shown={saved && !dirty} />
        {failed && (
          <p role="alert" className="text-sm text-critical">
            {t("servers.thresholds.errors.generic")}
          </p>
        )}
      </div>
    </form>
  );
}
