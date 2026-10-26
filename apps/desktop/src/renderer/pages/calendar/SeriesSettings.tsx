import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  calendarReadWindow,
  useCalendarSeries,
  useConfigureSeries,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import type { CalendarSeries, CalendarSeriesPatch } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { CloseIcon, InlineConfirm, ghostButton } from "../task/parts";
import { shortDate, timeLabel } from "./calendarFormat";
import { windowDays } from "./calendarParams";
import { useRecurrenceWords } from "./SeriesSidebar";

// Una serie ricorrente nel pannello (`?series=`, shape calendar.md §6): il
// titolo, la regola, quante date nella finestra letta e la prossima, poi la
// CONFIGURAZIONE — proposte (spente di default), progetto (obbligatorio
// prima di accendere), azione, giorni di anticipo, «Act automatically» (che
// non avvia MAI il lavoro di Claude), «Remove configuration». Ogni modifica
// si salva subito, con «Saving…»/«Saved» in testa.

const ACTIONS: CalendarSeries["action"][] = ["milestone", "request", "remind"];
const MAX_LEAD = 14;

export function SeriesSettings({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const series = useCalendarSeries();
  const projects = useProjects().data ?? [];
  const configure = useConfigureSeries();
  const words = useRecurrenceWords();
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);
  const ids = { project: useId(), lead: useId(), action: useId() };
  const win = windowDays(calendarReadWindow());
  const s = series.data?.find((x) => x.id === seriesId);

  const top = (
    <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      <span role="status" className="text-xs text-ink-muted">
        {configure.isPending ? t("calendar.save.saving") : saved ? t("calendar.save.saved") : ""}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("calendar.detail.close")}
        title={t("calendar.detail.close")}
        className={`${ghostButton} ml-auto w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </div>
  );
  if (series.isPending) return <div aria-busy="true">{top}</div>;
  if (!s) {
    return (
      <div data-series-detail={seriesId}>
        {top}
        <p role="alert" className="px-4 text-md text-ink">
          {t("calendar.series.unavailable")}
        </p>
      </div>
    );
  }

  const save = (patch: CalendarSeriesPatch) => {
    setError(null);
    setSaved(false);
    configure.mutate(
      { id: s.id, patch },
      {
        onSuccess: () => setSaved(true),
        onError: (e) =>
          setError(
            e instanceof Error && e.message === "choose_project_first"
              ? t("calendar.series.chooseProjectFirst")
              : t("calendar.series.saveFailed"),
          ),
      },
    );
  };
  const mine = projects.filter((p) => p.memberIds.includes(me));
  const rule = words(s.rule);

  return (
    <div data-series-detail={s.id} className="flex flex-col pb-6">
      {top}
      <header className="flex flex-col gap-1 px-4 pb-4">
        <h2 className="text-xl font-semibold text-ink">{s.title}</h2>
        {rule && (
          <p className="text-md text-ink">
            {rule}
            {s.nextAt ? ` · ${timeLabel(s.nextAt, i18n.language)}` : ""}
          </p>
        )}
        <p className="num text-sm text-ink-muted">
          {s.occurrencesInWindow === 0
            ? t("calendar.series.noDates")
            : t("calendar.series.dates", {
                count: s.occurrencesInWindow,
                from: shortDate(win.first, i18n.language),
                to: shortDate(win.last, i18n.language),
              })}
          {s.nextAt &&
            ` · ${t("calendar.series.next", {
              date: new Intl.DateTimeFormat(i18n.language, {
                weekday: "short",
                month: "short",
                day: "numeric",
              }).format(new Date(s.nextAt)),
            })}`}
        </p>
      </header>

      <section className="flex flex-col gap-4 border-t border-rule px-4 py-4">
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            role="switch"
            checked={s.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="mt-0.5 size-3.5 accent-[var(--ink)]"
          />
          <span className="flex flex-col">
            <span className="font-medium">{t("calendar.series.proposals")}</span>
            <span className="text-xs text-ink-muted">{t("calendar.series.proposalsNote")}</span>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-xs text-critical">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.project} className="text-sm font-medium text-ink">
            {t("calendar.editor.project")}
          </label>
          <select
            id={ids.project}
            value={s.projectId ?? ""}
            onChange={(e) => save({ projectId: e.target.value || null })}
            className={inputClass}
          >
            <option value="">{t("calendar.detail.noProject")}</option>
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} {p.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1 text-sm font-medium text-ink">
            {t("calendar.series.action")}
          </legend>
          {ACTIONS.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={ids.action}
                checked={s.action === a}
                onChange={() => save({ action: a })}
                className="size-3.5 accent-[var(--ink)]"
              />
              {t(`calendar.series.actions.${a}`)}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.lead} className="text-sm font-medium text-ink">
            {t("calendar.series.daysAhead")}
          </label>
          <input
            id={ids.lead}
            type="number"
            min={0}
            max={MAX_LEAD}
            step={1}
            value={s.leadDays}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n <= MAX_LEAD) save({ leadDays: n });
            }}
            className={`${inputClass} num w-24`}
          />
          <span className="text-xs text-ink-muted">
            {t("calendar.series.leadNote", { count: s.leadDays })}
          </span>
        </div>

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            role="switch"
            checked={s.auto}
            onChange={(e) => save({ auto: e.target.checked })}
            className="mt-0.5 size-3.5 accent-[var(--ink)]"
          />
          <span className="flex flex-col">
            <span className="font-medium">{t("calendar.series.actAuto")}</span>
            <span className="text-xs text-ink-muted">{t("calendar.series.actAutoNote")}</span>
          </span>
        </label>

        <p className="text-xs text-ink-muted">{t("calendar.series.neverPast")}</p>

        {confirmRemove ? (
          <InlineConfirm
            message={t("calendar.series.removeConfirm")}
            confirm={t("calendar.series.remove")}
            cancelLabel={t("calendar.cancel")}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={() => {
              setConfirmRemove(false);
              save({
                enabled: false,
                auto: false,
                projectId: null,
                action: "milestone",
                leadDays: 1,
              });
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            className={`${ghostButton} self-start`}
          >
            {t("calendar.series.remove")}
          </button>
        )}
      </section>
    </div>
  );
}
