import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomation,
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  useMailboxes,
} from "../../data/queries";
import type { AutomationDetail as Detail, AutomationRow } from "../../data/types";
import { AUTOMATION_LIMITS } from "../../domain/automations/fields";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { BlockSection, queryState } from "../home/blocks/BlockSection";
import { MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import {
  DeleteDraftDialog,
  DuplicateDialog,
  PauseDialog,
  RunNowDialog,
  TurnOnDialog,
} from "./AutomationDialogs";
import { FlowSummary } from "./FlowSummary";
import { fieldLabels, isFinished, positionWords, shortDate } from "./format";
import { CriticalGlyph, MoreGlyph } from "./glyphs";
import { orderRuns, RunRows } from "./RunList";
import { AutomationStatusWord, codeClass, textLink, useAttention, useMe, useNames } from "./shared";

// Il dettaglio di un'automazione (shape automations.md §6): una colonna di
// lettura fino a 960 px — testata con la riga di stato in prosa e le azioni,
// «Problems» (solo se ce ne sono), «Runs» (prima del riassunto, [A 8]),
// «How it works», «Versions», «About». Ogni sezione tiene i suoi stati.

/** Quante esecuzioni finite si vedono prima di «Show all N». */
const FINISHED_CAP = 10;

function StatusLine({ a }: { a: AutomationRow }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const owner = names.person(a.ownerId);
  // «‖ Paused by Laura Bianchi on Oct 20 · 1 run suspended» / «○ Draft · never turned on · created by Paolo Neri».
  const text =
    a.status === "active"
      ? t("automations.detail.statusActive", {
          n: live?.n ?? 1,
          owner,
          date: shortDate(live?.publishedAt ?? a.createdAt, i18n.language),
        })
      : a.status === "paused"
        ? a.pausedById && a.pausedAt
          ? t("automations.detail.statusPausedBy", {
              who: names.person(a.pausedById),
              date: shortDate(a.pausedAt, i18n.language),
              count: a.openRuns,
            })
          : t("automations.detail.statusPaused", { owner, count: a.openRuns })
        : a.createdById
          ? t("automations.detail.statusDraftBy", {
              who: names.person(a.createdById),
              date: shortDate(a.createdAt, i18n.language),
            })
          : t("automations.detail.statusDraft", { date: shortDate(a.createdAt, i18n.language) });
  return (
    <p data-status-line className="flex flex-wrap items-center gap-x-1.5 text-md text-ink-muted">
      <AutomationStatusWord status={a.status} />
      <span>· {text}</span>
      {a.status !== "draft" && a.hasDraft && (
        <span className="num text-xs">
          · {t("automations.row.draftOf", { n: a.versions.at(-1)!.n })}
        </span>
      )}
    </p>
  );
}

function Header({
  detail,
  onTurnOn,
  onPause,
  onDelete,
  onRunNow,
  onDuplicate,
}: {
  detail: Detail;
  onTurnOn: () => void;
  onPause: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();
  const names = useNames();
  const toast = useToast();
  const a = detail.automation;
  const manage = a.permissions.manage;
  const project = names.project(a.projectId);
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const manual = live?.flow.trigger.kind === "manual";
  const neverOn = a.versions.length === 1 && a.versions[0]!.publishedAt === null;
  const editLink = (label: string, primary = false, to: "edit" | "test" = "edit") => (
    <Link
      to={to === "edit" ? "/automations/$code/edit" : "/automations/$code/test"}
      params={{ code: a.code }}
      className={primary ? primaryButton : secondaryButton}
    >
      {label}
    </Link>
  );
  return (
    <header className="page-header flex shrink-0 flex-col gap-2 pb-6 [--page-header-pr:32px] [--page-header-pt:32px]">
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <span className={codeClass}>{a.code}</span>
        <span aria-hidden="true">·</span>
        {project ? (
          <Link to="/p/$code" params={{ code: project.code }} className={textLink}>
            {project.code} · {project.name}
          </Link>
        ) : (
          <span>{t("automations.general")}</span>
        )}
      </p>
      <div className="flex items-start gap-4">
        <h1 className="line-clamp-3 min-w-0 flex-1 text-2xl font-semibold text-ink [overflow-wrap:anywhere]">
          {a.name}
        </h1>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {manage && a.status === "draft" && (
            <>
              {editLink(t("automations.actions.edit"))}
              {editLink(t("automations.actions.test"), false, "test")}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.turnOn")}
              </button>
            </>
          )}
          {manage && a.status === "active" && !a.hasDraft && (
            <>
              <button type="button" className={secondaryButton} onClick={onPause}>
                {t("automations.actions.pause")}
              </button>
              {editLink(t("automations.actions.edit"), true)}
            </>
          )}
          {manage && a.status === "active" && a.hasDraft && (
            <>
              <button type="button" className={secondaryButton} onClick={onPause}>
                {t("automations.actions.pause")}
              </button>
              {editLink(t("automations.actions.openDraft"))}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.publishN", { n: a.versions.at(-1)!.n })}
              </button>
            </>
          )}
          {manage && a.status === "paused" && (
            <>
              {editLink(t("automations.actions.edit"))}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.turnOn")}
              </button>
            </>
          )}
          <MenuButton
            menuLabel={t("automations.detail.more")}
            ariaLabel={t("automations.detail.more")}
            align="right"
            className={`${quietButton} w-8 justify-center px-0`}
            label={<MoreGlyph />}
          >
            {(close) => (
              <MenuGroup>
                {manage && manual && a.status === "active" && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      onRunNow();
                    }}
                  >
                    {t("automations.actions.runNow")}
                  </button>
                )}
                {manage && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      onDuplicate();
                    }}
                  >
                    {t("automations.actions.duplicate")}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    void navigator.clipboard?.writeText(`#/automations/${a.code}`).catch(() => {});
                    toast.show(t("automations.toast.linkCopied"));
                  }}
                >
                  {t("automations.actions.copyLink")}
                </button>
                {manage && neverOn && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      onDelete();
                    }}
                  >
                    {t("automations.actions.deleteDraft")}
                  </button>
                )}
              </MenuGroup>
            )}
          </MenuButton>
        </div>
      </div>
      {a.description && <Description text={a.description} />}
      <StatusLine a={a} />
    </header>
  );
}

function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className="flex max-w-[72ch] flex-col items-start gap-0.5">
      <p className={`text-md text-ink-muted ${open || !long ? "" : "line-clamp-3"}`}>{text}</p>
      {long && (
        <button
          type="button"
          className="text-sm text-ink underline-offset-4 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("automations.detail.less") : t("automations.detail.more")}
        </button>
      )}
    </div>
  );
}

function ProblemsSection({
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

function RunsSection({ detail }: { detail: Detail }) {
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

function HowItWorks({
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

function VersionsSection({
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

function AboutSection({ detail }: { detail: Detail }) {
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

export function AutomationDetail({ automationId }: { automationId: string }) {
  const { t } = useTranslation();
  const query = useAutomation(automationId);
  const toast = useToast();
  const [dialog, setDialog] = useState<"on" | "pause" | "delete" | "run" | "duplicate" | null>(
    null,
  );
  const [duplicateVersion, setDuplicateVersion] = useState<number | undefined>(undefined);
  const [viewing, setViewing] = useState<number | null>(null);
  const problems = useRef<HTMLElement>(null);
  const detail = query.data;
  const search = useSearch({ strict: false }) as { problems?: string };
  // `?problems=1` (dall'elenco, «Turn on» con problemi): alla sezione Problems.
  const hasDetail = detail !== undefined;
  useEffect(() => {
    if (!hasDetail || search.problems !== "1") return;
    problems.current?.scrollIntoView?.({ block: "start" });
    problems.current?.focus();
  }, [hasDetail, search.problems]);
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-8 py-10">
        <p className="text-md text-ink">{t("automations.errors.loadOne")}</p>
        <button type="button" className={secondaryButton} onClick={() => void query.refetch()}>
          {t("automations.actions.retry")}
        </button>
      </div>
    );
  }
  if (!detail) return <DetailSkeleton />;
  const a = detail.automation;
  const turnOn = () => {
    const issues = a.status === "paused" ? detail.liveErrors : detail.configErrors;
    if (issues.length > 0) {
      problems.current?.scrollIntoView({ block: "start" });
      problems.current?.focus();
      toast.error(t("automations.toast.fixFirst", { count: issues.length }));
      return;
    }
    setDialog("on");
  };
  const duplicateOf = (n: number) => {
    setDuplicateVersion(n);
    setDialog("duplicate");
  };
  return (
    <article className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col pr-8">
        <Header
          detail={detail}
          onTurnOn={turnOn}
          onPause={() => setDialog("pause")}
          onDelete={() => setDialog("delete")}
          onRunNow={() => setDialog("run")}
          onDuplicate={() => {
            setDuplicateVersion(undefined);
            setDialog("duplicate");
          }}
        />
        <ProblemsSection detail={detail} focusRef={problems} />
        {a.status === "draft" ? (
          <>
            <HowItWorks
              detail={detail}
              viewing={viewing}
              onBack={() => setViewing(null)}
              onDuplicate={duplicateOf}
            />
            <RunsSection detail={detail} />
          </>
        ) : (
          <>
            <RunsSection detail={detail} />
            <HowItWorks
              detail={detail}
              viewing={viewing}
              onBack={() => setViewing(null)}
              onDuplicate={duplicateOf}
            />
          </>
        )}
        <VersionsSection detail={detail} viewing={viewing} onView={setViewing} />
        <AboutSection detail={detail} />
      </div>
      {dialog === "on" && <TurnOnDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "pause" && <PauseDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <DeleteDraftDialog automationId={a.id} onClose={() => setDialog(null)} />
      )}
      {dialog === "run" && <RunNowDialog automationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === "duplicate" && (
        <DuplicateDialog
          automationId={a.id}
          version={duplicateVersion}
          onClose={() => setDialog(null)}
        />
      )}
    </article>
  );
}

/** Lo scheletro del dettaglio: intestazione e quattro righe. */
export function DetailSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div
      aria-busy="true"
      className="skeleton-breathe flex max-w-[960px] flex-col gap-3 py-8 pr-8 pl-8"
    >
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`h-3 w-24 ${bar}`} />
      <span className={`h-7 w-96 ${bar}`} />
      <span className={`h-3 w-72 ${bar}`} />
      <div className="mt-6 flex flex-col border-t border-rule">
        {[62, 48, 71, 40].map((w) => (
          <span key={w} className="flex h-10 items-center border-b border-rule">
            <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}
