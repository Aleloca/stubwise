import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  useMailboxes,
} from "../../data/queries";
import type { AutomationDetail as Detail, AutomationFlow } from "../../data/types";
import { AUTOMATION_LIMITS, stepAt } from "../../domain/automations/fields";
import { BlockSection, queryState } from "../home/blocks/BlockSection";
import { quietButton } from "../tasks/controls";
import { FlowSummary } from "./FlowSummary";
import { fieldLabels, isFinished, positionWords, shortDate } from "./format";
import { CriticalGlyph } from "./glyphs";
import { orderRuns, RunRows } from "./RunList";
import { useAttention, useMe, useNames } from "./shared";

// Le sezioni del dettaglio (vedi `AutomationDetail.tsx`): «Problems»,
// «Runs», «How it works», «Versions», «About».

/** Quante esecuzioni finite si vedono prima di «Show all N». */
const FINISHED_CAP = 10;

/**
 * «Fix»: il costruttore apre il passo del problema per id (la bozza può
 * avere un'altra forma della versione pubblicata), o l'inizio.
 */
function fixSearch(flow: AutomationFlow, path: string): { step?: string } {
  if (path === "") return {};
  if (path === "trigger") return { step: "trigger" };
  const id = stepAt(flow.steps, path.replace(/\[\d+\]/g, "[0]"))?.id;
  return id ? { step: id } : {};
}

export function ProblemsSection({
  detail,
  focusRef,
}: {
  detail: Detail;
  focusRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const a = detail.automation;
  const latest = a.versions.at(-1)!;
  const liveVersion = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  // La versione pubblicata (un'attiva o in pausa: le esecuzioni si fermano lì) e
  // la bozza (mai accesa, o la versione successiva: non si accende né si pubblica).
  const lists = [
    ...(a.status !== "draft" && liveVersion && detail.liveErrors.length > 0
      ? [{ key: "live", issues: detail.liveErrors, flow: liveVersion.flow }]
      : []),
    ...(latest.publishedAt === null && detail.configErrors.length > 0
      ? [{ key: "draft", issues: detail.configErrors, flow: latest.flow }]
      : []),
  ];
  if (lists.length === 0) return null;
  const neverOn = a.status === "draft";
  return (
    <section
      ref={focusRef}
      tabIndex={-1}
      aria-labelledby="automation-problems"
      data-problems-section
      className="border-t border-rule pt-5 pb-7 outline-none"
    >
      <h2
        id="automation-problems"
        className="flex items-center gap-2 pb-3 text-xl font-semibold text-ink"
      >
        <CriticalGlyph />
        {t("automations.problems.title", {
          count: lists.reduce((n, l) => n + l.issues.length, 0),
        })}
      </h2>
      {lists.map((list) => (
        <div key={list.key} data-problems={list.key} className="pb-3">
          <p className="pb-1.5 text-sm text-ink-muted">
            {list.key === "live"
              ? t("automations.problems.live", { count: list.issues.length })
              : neverOn
                ? t("automations.problems.draft", { count: list.issues.length })
                : t("automations.problems.nextDraft", { count: list.issues.length, n: latest.n })}
          </p>
          <ul className="border-t border-rule">
            {list.issues.map((i, k) => (
              <li
                key={k}
                className="flex min-h-10 items-center gap-4 border-b border-rule py-2 pl-1"
              >
                <span className="w-56 shrink-0 text-sm text-ink-muted">
                  {positionWords(list.flow, i.path, t)}
                </span>
                <span className="min-w-0 flex-1 text-md text-ink" title={i.message}>
                  {t(`automations.issue.${i.code}`)}
                </span>
                {a.permissions.manage && (
                  <Link
                    to="/automations/$code/edit"
                    params={{ code: a.code }}
                    // Il costruttore apre il passo del problema (o l'inizio).
                    // Il passo per id: un problema della versione pubblicata porta allo stesso passo della bozza.
                    search={fixSearch(list.flow, i.path) as never}
                    className={`${quietButton} h-7`}
                  >
                    {t("automations.actions.fix")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function RunsSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const a = detail.automation;
  const runs = useAutomationRuns({ automationId: a.id });
  const attention = useAttention();
  const all = runs.data ?? [];
  const open = orderRuns(
    all.filter((r) => r.status !== "done" && r.status !== "cancelled"),
    attention.waitingMe,
  );
  const finished = all.filter((r) => r.status === "done" || r.status === "cancelled");
  const current = a.versions.filter((v) => v.publishedAt !== null).at(-1)?.n;
  const manual =
    a.versions.filter((v) => v.publishedAt !== null).at(-1)?.flow.trigger.kind === "manual";
  return (
    <BlockSection
      title={t("automations.detail.runs")}
      count={all.length}
      state={queryState([runs], {
        when: all.length === 0,
        text: t("automations.detail.noRuns"),
        body: manual && a.permissions.manage ? t("automations.detail.noRunsManual") : undefined,
      })}
    >
      {open.length > 0 && (
        <div className="pb-4">
          <p className="heading-group px-3 pb-1.5">{t("automations.detail.inProgress")}</p>
          <div className="border-t border-rule">
            <RunRows
              runs={open}
              label={t("automations.detail.inProgress")}
              currentVersion={current}
            />
          </div>
        </div>
      )}
      {finished.length > 0 && (
        <div>
          <p className="heading-group px-3 pb-1.5">{t("automations.detail.finished")}</p>
          <div className="border-t border-rule">
            <RunRows
              runs={finished.slice(0, FINISHED_CAP)}
              label={t("automations.detail.finished")}
              currentVersion={current}
            />
          </div>
          {finished.length > FINISHED_CAP && (
            <Link
              to="/automations"
              search={{ view: "runs", automation: a.code, status: "finished" } as never}
              className={`${quietButton} mt-1`}
            >
              {t("automations.detail.showAll", { count: finished.length })}
            </Link>
          )}
        </div>
      )}
    </BlockSection>
  );
}

export function HowItWorks({
  detail,
  viewing,
  onBack,
  onDuplicate,
}: {
  detail: Detail;
  viewing: number | null;
  onBack: () => void;
  /** «Duplicate this version»: riprendere una versione vecchia ([A 11]). */
  onDuplicate: (n: number) => void;
}) {
  const { t } = useTranslation();
  const names = useNames();
  const sources = useAutomationSources().data ?? [];
  const automations = useAutomations().data ?? [];
  const a = detail.automation;
  const version = viewing === null ? a.versions.at(-1)! : a.versions.find((v) => v.n === viewing)!;
  const labels = useMemo(() => fieldLabels(version.flow, sources), [version.flow, sources]);
  const codeOf = (id: string) => automations.find((x) => x.id === id)?.code ?? null;
  return (
    <section aria-labelledby="automation-how" className="border-t border-rule pt-5 pb-7">
      <FlowSummary
        title={
          <h2 id="automation-how" className="text-xl font-semibold text-ink">
            {t("automations.detail.how")}
          </h2>
        }
        flow={version.flow}
        names={names}
        labels={labels}
        sources={sources}
        projectId={a.projectId}
        ownerId={a.ownerId}
        automationCode={codeOf}
        header={
          viewing !== null ? (
            <p data-old-version className="text-sm text-ink-muted">
              {t("automations.detail.lookingAt", { n: viewing })}{" "}
              <button
                type="button"
                className="text-ink underline underline-offset-4"
                onClick={onBack}
              >
                {t("automations.detail.backToCurrent")}
              </button>
              {a.permissions.manage && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="text-ink underline underline-offset-4"
                    onClick={() => onDuplicate(viewing)}
                  >
                    {t("automations.detail.duplicateVersion")}
                  </button>
                </>
              )}
            </p>
          ) : version.publishedAt === null && a.status !== "draft" ? (
            <p className="text-sm text-ink-muted">
              {t("automations.detail.showingDraft", { n: version.n })}
            </p>
          ) : null
        }
      />
      {a.permissions.manage && (
        <Link
          to="/automations/$code/edit"
          params={{ code: a.code }}
          className={`${quietButton} mt-2`}
        >
          {t("automations.detail.openBuilder")}
        </Link>
      )}
    </section>
  );
}

export function VersionsSection({
  detail,
  viewing,
  onView,
}: {
  detail: Detail;
  viewing: number | null;
  onView: (n: number | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const runs = useAutomationRuns({ automationId: detail.automation.id }).data ?? [];
  const a = detail.automation;
  const current = a.versions.filter((v) => v.publishedAt !== null).at(-1)?.n;
  return (
    <section aria-labelledby="automation-versions" className="border-t border-rule pt-5 pb-7">
      <h2 id="automation-versions" className="pb-3 text-xl font-semibold text-ink">
        {t("automations.detail.versions")}
      </h2>
      <ul className="border-t border-rule">
        {[...a.versions].reverse().map((v) => {
          const open = runs.filter((r) => r.version === v.n && !isFinished(r.status)).length;
          const parts =
            v.publishedAt === null
              ? [t("automations.version.draft")]
              : [
                  t("automations.version.publishedBy", { name: names.person(v.publishedById) }),
                  shortDate(v.publishedAt, i18n.language),
                  ...(v.n === current ? [t("automations.version.current")] : []),
                  ...(open > 0 ? [t("automations.row.running", { count: open })] : []),
                ];
          const label = `${t("automations.version.short", { n: v.n })} · ${parts.join(" · ")}`;
          return (
            <li key={v.n} className="border-b border-rule">
              {v.publishedAt !== null && v.n !== current ? (
                <button
                  type="button"
                  aria-pressed={viewing === v.n}
                  onClick={() => onView(viewing === v.n ? null : v.n)}
                  className="flex min-h-10 w-full items-center px-3 text-left text-md text-ink hover:bg-ink/6 aria-pressed:bg-ink/10"
                >
                  {label}
                </button>
              ) : (
                <p className="flex min-h-10 items-center px-3 text-md text-ink">{label}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AboutSection({ detail }: { detail: Detail }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const me = useMe();
  const mailbox = useMailboxes().data?.[0]?.email;
  const a = detail.automation;
  const project = names.project(a.projectId);
  const owner = names.person(a.ownerId);
  return (
    <section aria-labelledby="automation-about" className="border-t border-rule pt-5 pb-7">
      <h2 id="automation-about" className="pb-3 text-xl font-semibold text-ink">
        {t("automations.detail.about")}
      </h2>
      <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-md">
        <dt className="text-ink-muted">{t("automations.about.owner")}</dt>
        <dd className="text-ink">
          {a.ownerId
            ? a.ownerId === me && mailbox
              ? t("automations.about.actsAsMe", { owner, mailbox })
              : t("automations.about.actsAs", { owner })
            : t("automations.about.noOwner")}
        </dd>
        <dt className="text-ink-muted">{t("automations.about.project")}</dt>
        <dd className="text-ink">
          {project ? `${project.code} · ${project.name}` : t("automations.general")}
        </dd>
        <dt className="text-ink-muted">{t("automations.about.created")}</dt>
        <dd className="num text-ink">{shortDate(a.createdAt, i18n.language)}</dd>
      </dl>
      <p className="pt-3 text-xs text-ink-muted">
        {t("automations.about.limits", {
          emails: AUTOMATION_LIMITS.emailsPerRun,
          rounds: AUTOMATION_LIMITS.forEachRounds,
          runs: 100,
        })}
      </p>
    </section>
  );
}
