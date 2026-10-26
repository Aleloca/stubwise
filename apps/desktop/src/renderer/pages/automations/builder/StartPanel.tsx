import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { triggerFields } from "../../../domain/automations/fields";
import type { AutomationTrigger, DataField } from "../../../data/types";
import { Dialog } from "../../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { CriticalGlyph, Disclosure, SourceGlyph, StepGlyph } from "../glyphs";
import { useAutomationPerms } from "../shared";
import { ConditionEditor } from "./ConditionEditor";
import { useBuilder } from "./context";
import { DataText, sampleOf } from "./DataText";
import { startProblems } from "./issues";
import { Field, Note, Section, selectClass } from "./controls";
import { brokenBy, emptyCondition } from "./tree";

// L'inizio (shape builder §6): l'elenco degli inizi a gruppi (dagli altri
// sistemi, da Stubwise, a calendario, a mano), i loro parametri (il filtro
// col costruttore di condizioni, la ricorrenza a menu — mai una RRULE
// scritta), il titolo delle esecuzioni e DATA YOU CAN USE: etichetta, tipo
// in parole, esempio dall'ultimo evento. Cambiare inizio quando dei passi ne
// usano i dati chiede conferma, e quei passi mostreranno il problema.

type Stubwise = Extract<AutomationTrigger, { kind: "stubwise" }>["event"];
const STUBWISE: Stubwise[] = [
  "task_created",
  "task_closed",
  "request_created",
  "milestone_reached",
  "mail_received",
];

const same = (a: AutomationTrigger, b: AutomationTrigger) =>
  a.kind === b.kind &&
  (a.kind !== "source" || (b.kind === "source" && a.sourceId === b.sourceId)) &&
  (a.kind !== "stubwise" || (b.kind === "stubwise" && a.event === b.event));

export function StartPanel({ dataRef }: { dataRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const perms = useAutomationPerms();
  const [confirm, setConfirm] = useState<{ trigger: AutomationTrigger; count: number } | null>(
    null,
  );
  const tr = b.flow.trigger;
  const problems = startProblems(b.issues.start, b.flow, b.names, t);
  const fields = triggerFields(b.flow, b.sources);

  const choose = (next: AutomationTrigger) => {
    if (same(tr, next)) return;
    const after = { ...b.flow, trigger: next };
    const broken = brokenBy(b.flow, after, b.sources).length;
    if (broken > 0) setConfirm({ trigger: next, count: broken });
    else b.update((f) => ({ ...f, trigger: next }));
  };

  const option = (
    key: string,
    label: string,
    trigger: AutomationTrigger,
    glyph: React.ReactNode,
    extra?: string,
  ) => {
    const on = same(tr, trigger) && !(tr.kind === "source" && tr.sourceId === "");
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={b.readOnly}
        onClick={() => choose(trigger)}
        className={`flex min-h-8 items-center gap-2.5 rounded-md px-2 text-left text-md ${on ? "bg-ink/10 font-medium text-ink" : "text-ink hover:bg-ink/6"}`}
      >
        {glyph}
        <span className="min-w-0 flex-1">{label}</span>
        {extra && <span className="text-xs text-critical">{extra}</span>}
      </button>
    );
  };

  return (
    <div data-start-panel className="flex flex-col pb-10">
      <header className="flex flex-col gap-1 px-5 pt-5 pb-4">
        <div className="flex items-center gap-2">
          <StepGlyph kind="trigger" />
          <h2 className="text-lg font-semibold text-ink">{t("automations.builder.start.title")}</h2>
        </div>
        {problems.length > 0 && (
          <ul className="flex flex-col gap-1 pt-2">
            {problems.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-critical">
                <CriticalGlyph />
                <span>
                  {p}
                  {b.issues.start[i]?.code === "source_disconnected" && (
                    <>
                      {" "}
                      {perms.integrations ? (
                        <Link
                          to="/automations/sources"
                          className="text-ink underline underline-offset-4"
                        >
                          {t("automations.builder.start.reconnect")}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">
                          {t("automations.builder.start.askSources")}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </header>
      <Section title={t("automations.builder.start.when")}>
        <div
          role="radiogroup"
          aria-label={t("automations.builder.start.when")}
          className="flex flex-col gap-3"
        >
          <Group title={t("automations.builder.start.fromOther")}>
            {b.sources.map((s) =>
              option(
                s.id,
                s.kind === "webhook"
                  ? t("automations.builder.start.webhook", { name: s.name })
                  : t("automations.builder.start.dealWon", { source: s.name }),
                {
                  kind: "source",
                  sourceId: s.id,
                  event: s.kind === "webhook" ? "webhook" : "deal_won",
                },
                <SourceGlyph kind={s.kind} />,
                s.status === "connected"
                  ? undefined
                  : t(`automations.builder.start.sourceStatus.${s.status}`),
              ),
            )}
            {b.sources.length === 0 && <Note>{t("automations.builder.start.noSources")}</Note>}
          </Group>
          <Group title={t("automations.builder.start.inStubwise")}>
            {STUBWISE.map((e) =>
              option(
                e,
                t(`automations.builder.start.stubwise.${e}`),
                { kind: "stubwise", event: e },
                <StepGlyph kind="trigger" />,
              ),
            )}
          </Group>
          <Group title={t("automations.builder.start.onSchedule")}>
            {option(
              "schedule",
              t("automations.builder.start.schedule"),
              { kind: "schedule", rule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" },
              <StepGlyph kind="wait" />,
            )}
          </Group>
          <Group title={t("automations.builder.start.byHand")}>
            {option(
              "manual",
              t("automations.builder.start.manual"),
              { kind: "manual" },
              <StepGlyph kind="trigger" />,
            )}
          </Group>
        </div>
      </Section>
      {tr.kind === "stubwise" && <FilterSection />}
      {tr.kind === "schedule" && <ScheduleSection rule={tr.rule} />}
      <Section title={t("automations.builder.start.runTitle")}>
        <Field label={t("automations.builder.start.runTitleLabel")} required>
          <DataText
            label={t("automations.builder.start.runTitleLabel")}
            value={b.flow.titleTemplate}
            onChange={(v) => b.update((f) => ({ ...f, titleTemplate: v }))}
            path="trigger"
          />
        </Field>
        <Note>{t("automations.builder.start.runTitleNote")}</Note>
      </Section>
      <section
        ref={dataRef}
        tabIndex={-1}
        aria-labelledby="builder-data-title"
        className="flex flex-col gap-3 border-t border-rule px-5 py-4 outline-none"
      >
        <h3 id="builder-data-title" className="heading-group">
          {t("automations.builder.start.dataTitle")}
        </h3>
        {fields.length === 0 ? (
          <Note>{t("automations.builder.start.noData")}</Note>
        ) : (
          <DataTable fields={fields} />
        )}
      </section>
      {confirm && (
        <Dialog
          title={t("automations.builder.start.changeTitle")}
          width={440}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setConfirm(null)}>
                {t("automations.actions.cancel")}
              </button>
              <button
                type="button"
                data-autofocus
                className={primaryButton}
                onClick={() => {
                  const next = confirm.trigger;
                  b.update((f) => ({ ...f, trigger: next }));
                  setConfirm(null);
                }}
              >
                {t("automations.builder.start.change")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">
            {t("automations.builder.start.changeBody", { count: confirm.count })}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-0.5">
      <p aria-hidden="true" className="pb-1 text-xs font-semibold text-ink-muted">
        {title}
      </p>
      {children}
    </div>
  );
}

function FilterSection() {
  const { t } = useTranslation();
  const b = useBuilder();
  const tr = b.flow.trigger as Extract<AutomationTrigger, { kind: "stubwise" }>;
  return (
    <Section title={t("automations.builder.start.filter")}>
      {tr.event === "mail_received" && <Note>{t("automations.builder.start.onlyYourMail")}</Note>}
      {tr.filter ? (
        <>
          <ConditionEditor
            value={tr.filter}
            onChange={(filter) => b.update((f) => ({ ...f, trigger: { ...tr, filter } }))}
            path=""
            label={t("automations.builder.start.filter")}
          />
          {!b.readOnly && (
            <button
              type="button"
              className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
              onClick={() =>
                b.update((f) => ({ ...f, trigger: { kind: "stubwise", event: tr.event } }))
              }
            >
              {t("automations.builder.start.removeFilter")}
            </button>
          )}
        </>
      ) : (
        <>
          <Note>{t("automations.builder.start.everyOne")}</Note>
          {!b.readOnly && (
            <button
              type="button"
              className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
              onClick={() =>
                b.update((f) => ({ ...f, trigger: { ...tr, filter: emptyCondition() } }))
              }
            >
              {t("automations.builder.start.addFilter")}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** La ricorrenza a menu: «Every [Monday] at [9:00]», «Every day at…», «On day [1] of every month at…». */
function ScheduleSection({ rule }: { rule: string }) {
  const { t, i18n } = useTranslation();
  const b = useBuilder();
  const parts = Object.fromEntries(
    rule.split(";").map((p) => p.split("=") as [string, string]),
  ) as Record<string, string | undefined>;
  const freq = parts.FREQ ?? "WEEKLY";
  const hour = Number(parts.BYHOUR ?? 9);
  const minute = Number(parts.BYMINUTE ?? 0);
  const write = (next: Record<string, string | number | undefined>) => {
    const p: Record<string, string | number | undefined> = {
      FREQ: freq,
      BYDAY: parts.BYDAY,
      BYMONTHDAY: parts.BYMONTHDAY,
      BYHOUR: hour,
      BYMINUTE: minute,
      ...next,
    };
    if (p.FREQ !== "WEEKLY") p.BYDAY = undefined;
    else p.BYDAY ??= "MO";
    if (p.FREQ !== "MONTHLY") p.BYMONTHDAY = undefined;
    else p.BYMONTHDAY ??= "1";
    if (!p.BYMINUTE) p.BYMINUTE = undefined;
    const rule = Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(";");
    b.update((f) => ({ ...f, trigger: { kind: "schedule", rule } }));
  };
  const dayName = (code: string) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 0, 5 + DAYS.indexOf(code))),
    );
  return (
    <Section title={t("automations.builder.start.recurrence")}>
      <div className="flex flex-wrap items-center gap-2 text-md text-ink">
        <select
          aria-label={t("automations.builder.start.every")}
          className={selectClass}
          value={freq}
          onChange={(e) => write({ FREQ: e.target.value })}
        >
          <option value="DAILY">{t("automations.builder.start.everyDay")}</option>
          <option value="WEEKLY">{t("automations.builder.start.everyWeek")}</option>
          <option value="MONTHLY">{t("automations.builder.start.everyMonth")}</option>
        </select>
        {freq === "WEEKLY" && (
          <select
            aria-label={t("automations.builder.start.day")}
            className={selectClass}
            value={parts.BYDAY?.split(",")[0] ?? "MO"}
            onChange={(e) => write({ BYDAY: e.target.value })}
          >
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {dayName(d)}
              </option>
            ))}
          </select>
        )}
        {freq === "MONTHLY" && (
          <select
            aria-label={t("automations.builder.start.dayOfMonth")}
            className={selectClass}
            value={parts.BYMONTHDAY ?? "1"}
            onChange={(e) => write({ BYMONTHDAY: e.target.value })}
          >
            {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <span className="text-ink-muted">{t("automations.builder.start.at")}</span>
        <select
          aria-label={t("automations.builder.start.time")}
          className={selectClass}
          value={`${hour}:${minute}`}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            write({ BYHOUR: h, BYMINUTE: m });
          }}
        >
          {Array.from({ length: 48 }, (_, i) => [Math.floor(i / 2), (i % 2) * 30] as const).map(
            ([h, m]) => (
              <option key={`${h}:${m}`} value={`${h}:${m}`}>
                {`${h}:${String(m).padStart(2, "0")}`}
              </option>
            ),
          )}
        </select>
      </div>
    </Section>
  );
}

/** DATA YOU CAN USE: etichetta, tipo in parole, esempio dall'ultimo evento; gli elenchi si aprono. */
function DataTable({ fields }: { fields: DataField[] }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tr = b.flow.trigger;
  const sample =
    tr.kind === "source"
      ? b.sources.find((s) => s.id === tr.sourceId)?.sampleEvents.at(-1)
      : undefined;
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="sr-only">
        <tr>
          <th>{t("automations.builder.start.colLabel")}</th>
          <th>{t("automations.builder.start.colType")}</th>
          <th>{t("automations.builder.start.colExample")}</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => {
          const list = f.type === "list" && (f.of?.length ?? 0) > 0;
          const isOpen = open.has(f.key);
          return [
            <tr key={f.key} className="border-b border-rule">
              <td className="py-1.5 pr-2 text-ink">
                {list ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    className="inline-flex items-center gap-1"
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(f.key)) n.delete(f.key);
                        else n.add(f.key);
                        return n;
                      })
                    }
                  >
                    <Disclosure open={isOpen} />
                    {f.label}
                  </button>
                ) : (
                  f.label
                )}
              </td>
              <td className="w-28 py-1.5 pr-2 text-ink-muted">
                {t(`automations.builder.types.${f.type}`)}
              </td>
              <td className="w-28 truncate py-1.5 text-ink-faint">
                {sampleOf(sample, f.key) ?? ""}
              </td>
            </tr>,
            ...(list && isOpen
              ? f.of!.map((s) => (
                  <tr key={`${f.key}.${s.key}`} className="border-b border-rule">
                    <td className="py-1.5 pr-2 pl-5 text-ink">{s.label}</td>
                    <td className="py-1.5 pr-2 text-ink-muted">
                      {t(`automations.builder.types.${s.type}`)}
                    </td>
                    <td />
                  </tr>
                ))
              : []),
          ];
        })}
      </tbody>
    </table>
  );
}
