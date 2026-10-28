import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenPrs, usePeople, useProject, useReleaseQueue } from "../../data/queries";
import type { OpenPrView, QueueItem } from "../../data/releases";
import { DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { formatDate } from "../../notifications/time";
import { CloseIcon, Section, ghostButton } from "../task/parts";
import { ago, clock, prProse, prUrl, riskWord, shortRepo, shortSha } from "./format";
import { ExternalGlyph, PrStateWord } from "./glyphs";
import { MergeButton, MergeExpansion, useMergeFlow } from "./MergeConfirm";
import { PrActions, PrSimulate } from "./PrActions";

// Il pannello di una PR (`?pr=<id>`, shape releases.md [R 5]): affiancato da
// 360px come i dettagli del resto dell'app. Testata, analisi di Claude
// (riassunto e problemi sono SUOI, e lo si dice), correzioni col contatore
// derivato ([R 13]), azioni, «Simula». Un `?pr=` sconosciuto chiude il
// pannello senza errore.

/** La sezione Releases di un progetto: l'unica route su cui si apre il pannello. */
const SECTION_PATH = /^\/p\/([^/]+)\/releases\/?$/;
/** I problemi che si vedono prima di «Show all N». */
const PROBLEMS_PAGE = 8;

function Analysis({ pr }: { pr: OpenPrView }) {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const a = pr.analysis;
  const off = pr.prState.state === "analysis_off";
  const risk = riskWord(pr, t);
  // [R 21]: con il repository spento le analisi già fatte non si mostrano più.
  if (off || !a) {
    return (
      <Section title={t("releases.panel.analysis")}>
        <PrStateWord pr={pr} />
        <p className="text-sm text-ink-muted">
          {off
            ? t("releases.prLine.analysisOff", { repo: shortRepo(pr.repo) })
            : t("releases.prLine.analyzing")}
        </p>
      </Section>
    );
  }
  const issues = all ? a.issues : a.issues.slice(0, PROBLEMS_PAGE);
  return (
    <Section title={t("releases.panel.analysis")}>
      <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
        <PrStateWord pr={pr} />
        <span className="num">
          {t("releases.panel.onSha", { sha: shortSha(a.sha), time: clock(a.at, i18n.language) })}
        </span>
        {risk && <span className={a.risk === "high" ? "text-critical" : undefined}>· {risk}</span>}
      </div>
      {a.summary && (
        <div className="flex flex-col items-start gap-1">
          <p className={`text-md text-ink [overflow-wrap:anywhere] ${more ? "" : "line-clamp-6"}`}>
            {a.summary}
          </p>
          {a.summary.length > 400 && (
            <button type="button" className={ghostButton} onClick={() => setMore((v) => !v)}>
              {more ? t("releases.panel.less") : t("releases.panel.more")}
            </button>
          )}
        </div>
      )}
      {a.issues.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-sm font-semibold text-ink">
            {t("releases.panel.problems")}{" "}
            <span className="num font-normal text-ink-faint">{a.issues.length}</span>
          </h4>
          <ol
            aria-label={t("releases.panel.problems")}
            className="flex list-decimal flex-col gap-1.5 pl-5 text-md text-ink marker:text-ink-faint marker:num"
          >
            {issues.map((issue, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                {issue.title}
                {issue.file && (
                  <a
                    href={`https://github.com/${pr.repo}/blob/${a.sha}/${issue.file}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1.5 inline-flex items-center gap-0.5 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                  >
                    {issue.file}
                    <ExternalGlyph />
                  </a>
                )}
              </li>
            ))}
          </ol>
          {a.issues.length > PROBLEMS_PAGE && (
            <button
              type="button"
              className={`${ghostButton} self-start`}
              onClick={() => setAll((v) => !v)}
            >
              {all ? t("releases.panel.less") : t("releases.showAll", { count: a.issues.length })}
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-ink-muted">{t("releases.panel.writtenByClaude")}</p>
    </Section>
  );
}

function Corrections({ pr }: { pr: OpenPrView }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const notFixable = pr.prState.notFixable;
  if (pr.origin !== "colleague") return null;
  if (notFixable) {
    return (
      <Section title={t("releases.panel.corrections")}>
        <p className="text-sm text-ink-muted">{t(`releases.notFixable.${notFixable}`)}</p>
      </Section>
    );
  }
  const list = [...pr.corrections].reverse();
  const by = (id: string | null) => people?.find((p) => p.id === id)?.name ?? "";
  return (
    <Section title={t("releases.panel.corrections")} count={list.length}>
      {list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((c) => {
            const n = pr.corrections.indexOf(c) + 1;
            const how =
              c.trigger === "auto"
                ? t("releases.panel.automatic")
                : t("releases.panel.askedBy", { name: by(c.byId) });
            return (
              <li key={c.id} className="flex flex-col gap-0.5">
                <p className="text-sm text-ink">
                  <span className="font-semibold">{t("releases.panel.correctionN", { n })}</span>
                  {" · "}
                  {c.state === "pushed" && c.commitSha
                    ? t("releases.panel.pushed", {
                        sha: shortSha(c.commitSha),
                        time: clock(c.at, i18n.language),
                      })
                    : t(`releases.panel.correction.${c.state}`, { name: pr.authorName })}
                  {" · "}
                  {how}
                </p>
                {c.why && (
                  <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">{c.why}</p>
                )}
                {c.commitSha && (
                  <a
                    href={`https://github.com/${pr.repo}/commit/${c.commitSha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 self-start text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                  >
                    {t("releases.panel.viewCommit")}
                    <ExternalGlyph />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="num text-sm text-ink-muted">
        {t("releases.panel.used", { used: Math.min(pr.prState.autoRound, pr.cap), cap: pr.cap })}
      </p>
    </Section>
  );
}

function PrBody({
  pr,
  queueItem,
  projectCode,
  onClose,
}: {
  pr: OpenPrView;
  queueItem: QueueItem | undefined;
  projectCode: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const flow = useMergeFlow(pr, projectCode);
  const author = people?.find((p) => p.id === pr.authorId)?.name ?? pr.authorName;
  const prose = prProse(pr, t);
  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="num text-xs font-semibold tracking-[0.02em] text-ink">
            {pr.repo}#{pr.number}
          </span>
          <a
            href={prUrl(pr)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {t("releases.openOn", { platform: "GitHub" })}
            <ExternalGlyph />
          </a>
          <button
            type="button"
            aria-label={t("releases.panel.close")}
            onClick={onClose}
            className="ml-auto grid size-7 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>
        <h2 className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">{pr.title}</h2>
        {/* Ogni riga ha la sua etichetta (shape §6): niente frasi orfane sotto il titolo. */}
        <dl className="grid grid-cols-[minmax(64px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-muted">{t("releases.panel.author")}</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">
            {author}
            {pr.fromFork && <span className="text-ink-muted"> · {t("releases.pr.fork")}</span>}
          </dd>
          <dt className="text-ink-muted">{t("releases.panel.branch")}</dt>
          <dd className="num min-w-0 text-ink">
            <span className="[overflow-wrap:anywhere]">{pr.branch}</span>{" "}
            {/* La destinazione non va mai a capo da sola. */}
            <span className="whitespace-nowrap">→ {pr.baseBranch}</span>
          </dd>
          {pr.taskCode && (
            <>
              <dt className="text-ink-muted">{t("releases.panel.task")}</dt>
              <dd>
                <Link
                  to="."
                  search={
                    ((prev: Record<string, unknown>) => ({
                      ...prev,
                      pr: undefined,
                      task: pr.taskCode,
                    })) as never
                  }
                  className="num rounded-sm font-semibold text-ink underline-offset-4 hover:underline"
                >
                  {pr.taskCode}
                </Link>
              </dd>
            </>
          )}
          {prose && (
            <>
              <dt className="text-ink-muted">{t("releases.panel.state")}</dt>
              <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{prose}</dd>
            </>
          )}
          <dt className="text-ink-muted">{t("releases.panel.opened")}</dt>
          <dd className="text-ink">
            {formatDate(pr.openedAt, i18n.language)}
            <span className="text-ink-muted"> · {ago(pr.openedAt, t, i18n.language)}</span>
          </dd>
        </dl>
        {queueItem?.canMerge && (
          <div className="flex flex-col pt-1">
            <span className="self-start">
              <MergeButton pr={pr} flow={flow} />
            </span>
            <MergeExpansion pr={pr} flow={flow} projectCode={projectCode} />
          </div>
        )}
      </header>
      <Analysis pr={pr} />
      <Corrections pr={pr} />
      <PrActions pr={pr} projectCode={projectCode} />
      <PrSimulate pr={pr} />
    </div>
  );
}

/**
 * Il pannello della PR si aggancia già a 1024 (shape releases §6
 * «1024×680»): la lista resta a ~360px e le sue righe si accorciano con le
 * container query di `PrRow` (riga 2 = stato e rischio, autore solo avatar),
 * invece di essere coperta. Più stretto si sovrappone, come il resto dell'app.
 */
export const PR_PANEL_DOCKED_QUERY = "(min-width: 1024px)";

/**
 * Montato dal layout: il pannello della PR su `?pr=` nella sezione Releases.
 * Fuori da lì non legge niente (nessuna query su ogni pagina).
 */
export function PrPanelHost() {
  const search = useSearch({ strict: false }) as { pr?: string; task?: string };
  const code = useRouterState({
    select: (s) => SECTION_PATH.exec(s.location.pathname)?.[1] ?? null,
  });
  if (!search.pr || !code || search.task) return null;
  return <PrPanelFor code={code} prId={search.pr} />;
}

function PrPanelFor({ code, prId }: { code: string; prId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const docked = useMediaQuery(PR_PANEL_DOCKED_QUERY);
  const project = useProject(code).data;
  const prs = useOpenPrs(project?.id);
  const queue = useReleaseQueue(project?.id);
  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({ ...prev, pr: undefined })) as never,
    });
  }, [navigate]);
  const pr = prs.data?.find((p) => p.id === prId);
  // Un `?pr=` che non c'è (o non si vede) chiude il pannello in silenzio.
  const unknown = project === null || (prs.data !== undefined && !pr);
  useEffect(() => {
    if (unknown) close();
  }, [unknown, close]);
  if (!pr || !project) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("releases.panel.label", { pr: `${shortRepo(pr.repo)}#${pr.number}` })}
      onClose={close}
    >
      <PrBody
        key={pr.id}
        pr={pr}
        queueItem={queue.data?.find((q) => q.id === pr.id)}
        projectCode={project.code}
        onClose={close}
      />
    </DetailPanel>
  );
}
