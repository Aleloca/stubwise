import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAutomationRuns, useAutomations, usePeople, useProjects } from "../../data/queries";
import type { AutomationRow as Row } from "../../data/types";
import { rowKeys } from "../home/blocks/BlockSection";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton, quietButton, secondaryButton, Chevron } from "../tasks/controls";
import { CreateAutomationDialog, type AutomationTemplate } from "./CreateAutomationDialog";
import { PauseDialog, TurnOnDialog } from "./AutomationDialogs";
import { stepCount, triggerWords, type Names } from "./format";
import { CriticalGlyph, MoreGlyph } from "./glyphs";
import { orderRuns, RunRows } from "./RunList";
import {
  AutomationStatusWord,
  codeClass,
  useAttention,
  useAutomationPerms,
  useMe,
  useNames,
} from "./shared";

// L'elenco delle automazioni (shape automations.md §6): filtri a gettone
// (progetto, stato, proprietario) nell'indirizzo, raggruppamento per progetto
// (GENERAL in testa), righe di 56 px su due linee. La vista «Needs attention»
// mette insieme le automazioni con problemi e le esecuzioni da sistemare.

export interface ListSearch {
  project?: string;
  general?: string;
  status?: string;
  owner?: string;
}

/** Un filtro a gettone: «Project», o «Project: AUD» quando è attivo; il menu ha «Any». */
export function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const active = value !== undefined;
  return (
    <MenuButton
      menuLabel={label}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${active ? "border-rule-strong bg-ink/6 text-ink" : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink"}`}
      label={
        <>
          <span className={active ? "text-ink-muted" : undefined}>{label}</span>
          {active && <span className="max-w-48 truncate font-medium">{value}</span>}
          <Chevron />
        </>
      }
    >
      {(close) => (
        <>
          <RadioItem
            checked={!active}
            onSelect={() => {
              onChange(undefined);
              close();
            }}
          >
            {t("automations.filters.any")}
          </RadioItem>
          {options.map((o) => (
            <RadioItem
              key={o.value}
              checked={value === o.value || value === o.label}
              onSelect={() => {
                onChange(o.value);
                close();
              }}
            >
              <span className="truncate">{o.label}</span>
            </RadioItem>
          ))}
        </>
      )}
    </MenuButton>
  );
}

/** Una riga d'automazione: codice · nome · stato · proprietario; sotto l'inizio, i passi, le esecuzioni, i problemi. */
export function AutomationRow({ a, names }: { a: Row; names: Names }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const people = usePeople().data;
  const [dialog, setDialog] = useState<"on" | "pause" | null>(null);
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const latest = a.versions.at(-1)!;
  const flow = (live ?? latest).flow;
  const trigger = triggerWords(flow.trigger, names, t, i18n.language, a.projectId);
  const suspended = a.status === "paused" ? a.openRuns : 0;
  const running = a.status === "paused" ? 0 : a.openRuns;
  const owner = a.ownerId ? names.person(a.ownerId) : null;
  const parts = [
    trigger,
    t("automations.row.steps", { count: stepCount(flow) }),
    running > 0 ? t("automations.row.running", { count: running }) : null,
    suspended > 0 ? t("automations.row.suspended", { count: suspended }) : null,
  ].filter(Boolean);
  const href = `#/automations/${a.code}`;
  return (
    <li className="group relative border-b border-rule">
      <Link
        to="/automations/$code"
        params={{ code: a.code }}
        data-automation-row={a.code}
        aria-label={t("automations.row.label", {
          code: a.code,
          name: a.name,
          status: t(`automations.status.${a.status}`),
          owner: owner ?? t("automations.row.noOwner"),
          runs: t("automations.row.running", { count: a.openRuns }),
        })}
        className="flex min-h-14 flex-col justify-center gap-0.5 rounded-md px-3 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className={`${codeClass} w-16 shrink-0`}>{a.code}</span>
          <span
            className="min-w-0 flex-1 truncate text-md text-ink"
            title={a.description || undefined}
          >
            {a.name}
          </span>
          <span className="flex w-36 shrink-0 items-center gap-1.5">
            <AutomationStatusWord status={a.status} />
            {a.status !== "draft" && a.hasDraft && (
              <span className="num truncate text-xs text-ink-muted">
                {t("automations.row.draftOf", { n: latest.n })}
              </span>
            )}
          </span>
          <span className="flex w-40 shrink-0 items-center gap-2 group-hover:invisible group-focus-within:invisible max-[1100px]:w-6">
            {a.ownerId ? (
              <>
                <Avatar person={people?.find((p) => p.id === a.ownerId)} />
                <span className="truncate text-sm text-ink-muted max-[1100px]:sr-only">
                  {owner}
                </span>
              </>
            ) : (
              <span className="text-sm text-ink-faint">—</span>
            )}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-[76px] text-sm text-ink-muted">
          <span className="truncate">{parts.join(" · ")}</span>
          {a.configErrorCount > 0 && (
            <span data-problems className="inline-flex shrink-0 items-center gap-1 text-critical">
              · <CriticalGlyph className="text-critical" />
              {t("automations.row.problems", { count: a.configErrorCount })}
            </span>
          )}
        </span>
      </Link>
      {/* Al passaggio, al posto del proprietario: «Open» e «⋯». */}
      <span className="pointer-events-none absolute top-2 right-3 flex items-center gap-1 opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <Link
          to="/automations/$code"
          params={{ code: a.code }}
          tabIndex={-1}
          className={`${quietButton} h-7`}
        >
          {t("automations.actions.open")}
        </Link>
        <MenuButton
          menuLabel={t("automations.row.menu", { code: a.code })}
          ariaLabel={t("automations.row.menu", { code: a.code })}
          align="right"
          className={`${quietButton} h-7 w-7 justify-center px-0`}
          label={<MoreGlyph />}
        >
          {(close) => (
            <MenuGroup>
              {a.permissions.manage && a.status !== "active" && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    setDialog("on");
                  }}
                >
                  {t("automations.actions.turnOn")}
                </button>
              )}
              {a.permissions.manage && a.status === "active" && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    setDialog("pause");
                  }}
                >
                  {t("automations.actions.pause")}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  close();
                  void navigator.clipboard?.writeText(href).catch(() => {});
                  toast.show(t("automations.toast.linkCopied"));
                }}
              >
                {t("automations.actions.copyLink")}
              </button>
            </MenuGroup>
          )}
        </MenuButton>
      </span>
      {dialog === "on" && <TurnOnDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "pause" && <PauseDialog automationId={a.id} onClose={() => setDialog(null)} />}
    </li>
  );
}

/** I due modelli del vuoto (shape [A 7]). */
function Templates({ projectId }: { projectId?: string | null }) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<AutomationTemplate | "blank" | null>(null);
  return (
    <div className="flex max-w-[720px] flex-col gap-1 pr-8">
      <p className="heading-group pb-1.5">{t("automations.templates.heading")}</p>
      <ul className="border-t border-rule">
        {(["newContract", "askClient"] as const).map((k) => (
          <li key={k} className="flex min-h-16 items-center gap-4 border-b border-rule py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-md font-medium text-ink">
                {t(`automations.templates.${k}.title`)}
              </span>
              <span className="text-sm text-ink-muted">{t(`automations.templates.${k}.body`)}</span>
            </span>
            <button type="button" className={secondaryButton} onClick={() => setTemplate(k)}>
              {t("automations.templates.use")}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={`${quietButton} self-start`}
        onClick={() => setTemplate("blank")}
      >
        {t("automations.templates.scratch")}
      </button>
      {template && (
        <CreateAutomationDialog
          template={template === "blank" ? undefined : template}
          projectId={projectId}
          onClose={() => setTemplate(null)}
        />
      )}
    </div>
  );
}

/** Il vuoto della destinazione: con il permesso i due modelli, senza una frase. */
export function AutomationsEmpty({ projectId }: { projectId?: string | null }) {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  if (!perms.anywhere) {
    return <PageEmpty title={t("automations.empty.none")} body={t("automations.empty.noneBody")} />;
  }
  return (
    <div className="flex flex-col gap-6 py-4">
      <p className="max-w-[60ch] text-md text-ink-muted">{t("automations.empty.intro")}</p>
      <Templates projectId={projectId} />
    </div>
  );
}

export function AutomationListView({ search }: { search: ListSearch }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const names = useNames();
  const list = useAutomations();
  const projects = useProjects().data ?? [];
  const people = usePeople().data ?? [];
  const perms = useAutomationPerms();
  const all = list.data ?? [];
  const project = projects.find((p) => p.code === search.project);
  const set = (patch: Partial<ListSearch>) =>
    void navigate({
      to: "/automations",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as never);
  const clear = () =>
    set({ project: undefined, general: undefined, status: undefined, owner: undefined });
  const filtering = !!(search.project || search.general || search.status || search.owner);

  const shown = all
    .filter((a) => !search.general || a.projectId === null)
    .filter((a) => !search.project || (project !== undefined && a.projectId === project.id))
    .filter((a) =>
      !search.status
        ? true
        : search.status === "problems"
          ? a.configErrorCount > 0
          : a.status === search.status,
    )
    .filter((a) => !search.owner || a.ownerId === search.owner);

  // GENERAL in testa, poi i progetti per codice; con un filtro progetto niente intestazioni.
  const groups = new Map<string, Row[]>();
  for (const a of shown)
    groups.set(a.projectId ?? "", [...(groups.get(a.projectId ?? "") ?? []), a]);
  const ordered = [...groups.entries()].sort(([x], [y]) =>
    x === ""
      ? -1
      : y === ""
        ? 1
        : (names.project(x)?.code ?? "").localeCompare(names.project(y)?.code ?? ""),
  );
  const headed = !search.project && !search.general;

  const ownerIds = [...new Set(all.map((a) => a.ownerId).filter((x): x is string => !!x))].sort(
    (a, b) => (a === me ? -1 : b === me ? 1 : names.person(a).localeCompare(names.person(b))),
  );
  const projectOptions = [
    ...(perms.instance ? [{ value: "general", label: t("automations.general") }] : []),
    ...projects
      .filter((p) => all.some((a) => a.projectId === p.id))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` })),
  ];

  if (list.isError) {
    return <PageError message={t("automations.errors.load")} onRetry={() => void list.refetch()} />;
  }
  if (list.data === undefined) return <PageSkeleton rows={6} />;
  if (all.length === 0) return <AutomationsEmpty />;

  return (
    <>
      <div
        role="toolbar"
        aria-label={t("automations.filters.label")}
        className="flex flex-wrap items-center gap-2 pr-8 pb-3"
      >
        <FilterChip
          label={t("automations.filters.project")}
          value={search.general ? t("automations.general") : project?.code}
          options={projectOptions}
          onChange={(v) =>
            set(
              v === "general"
                ? { general: "1", project: undefined }
                : { project: v, general: undefined },
            )
          }
        />
        <FilterChip
          label={t("automations.filters.status")}
          value={search.status ? t(`automations.statusFilter.${search.status}`) : undefined}
          options={(["active", "paused", "draft", "problems"] as const).map((s) => ({
            value: s,
            label: t(`automations.statusFilter.${s}`),
          }))}
          onChange={(v) => set({ status: v })}
        />
        <FilterChip
          label={t("automations.filters.owner")}
          value={
            search.owner
              ? search.owner === me
                ? t("automations.filters.me")
                : names.person(search.owner)
              : undefined
          }
          options={ownerIds.map((id) => ({
            value: id,
            label:
              id === me
                ? t("automations.filters.me")
                : (people.find((p) => p.id === id)?.name ?? id),
          }))}
          onChange={(v) => set({ owner: v })}
        />
        {filtering && (
          <button type="button" className={quietButton} onClick={clear}>
            {t("automations.filters.clear")}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <PageEmpty
          title={t("automations.empty.filtered")}
          action={
            <button type="button" className={quietButton} onClick={clear}>
              {t("automations.filters.clear")}
            </button>
          }
        />
      ) : (
        <section
          aria-label={t("automations.list.label")}
          onKeyDown={rowKeys("[data-automation-row]")}
          className="flex flex-col pr-8"
        >
          {ordered.map(([projectId, rows]) => {
            const p = names.project(projectId);
            return (
              <section
                key={projectId || "general"}
                aria-label={p ? `${p.code} · ${p.name}` : t("automations.general")}
                className="pb-4"
              >
                {headed && (
                  <p className="heading-group px-3 pb-1.5">
                    {p ? `${p.code} · ${p.name}` : t("automations.general")}
                  </p>
                )}
                <ul className="border-t border-rule">
                  {rows.map((a) => (
                    <AutomationRow key={a.id} a={a} names={names} />
                  ))}
                </ul>
              </section>
            );
          })}
        </section>
      )}
    </>
  );
}

/** «Needs attention»: le automazioni con problemi che gestisco, poi le esecuzioni da sistemare. */
export function AttentionView() {
  const { t } = useTranslation();
  const names = useNames();
  const list = useAutomations();
  const runs = useAutomationRuns();
  const attention = useAttention();
  if (list.isError || runs.isError) {
    return (
      <PageError
        message={t("automations.errors.load")}
        onRetry={() => {
          void list.refetch();
          void runs.refetch();
        }}
      />
    );
  }
  if (!attention.ready) return <PageSkeleton rows={6} />;
  const automations = (list.data ?? []).filter((a) => attention.automationIds.has(a.id));
  const stuck = orderRuns(
    (runs.data ?? []).filter((r) => attention.runIds.has(r.id)),
    attention.waitingMe,
  );
  if (automations.length === 0 && stuck.length === 0) {
    return (
      <PageEmpty
        title={t("automations.empty.attention")}
        body={t("automations.empty.attentionBody")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6 pr-8">
      {automations.length > 0 && (
        <section aria-label={t("automations.attention.automations")}>
          <p className="heading-group px-3 pb-1.5">{t("automations.attention.automations")}</p>
          <ul className="border-t border-rule" onKeyDown={rowKeys("[data-automation-row]")}>
            {automations.map((a) => (
              <AutomationRow key={a.id} a={a} names={names} />
            ))}
          </ul>
        </section>
      )}
      {stuck.length > 0 && (
        <section aria-label={t("automations.attention.runs")}>
          <p className="heading-group px-3 pb-1.5">{t("automations.attention.runs")}</p>
          <div className="border-t border-rule">
            <RunRows runs={stuck} label={t("automations.attention.runs")} />
          </div>
        </section>
      )}
    </div>
  );
}
