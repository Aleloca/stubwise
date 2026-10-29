import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  useConversation,
  usePeople,
  useProjects,
  useServerTaskInfo,
  useStartServerFix,
} from "../../data/queries";
import type { ServerTaskInfo } from "../../data/servers";
import type { EpisodeReason, ServerEpisode, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { Dialog } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { useToast } from "../../tasks-ui/Toast";
import { CheckGlyph, CrossGlyph, WorkingRing } from "../claude/conversation/parts";
import { clockLocal, dayLocal, isToday, sinceWhen } from "../servers/format";
import { HealthGlyph } from "../servers/glyphs";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { scrollPanelTo } from "./ClaudeSection";
import { Section, ghostButton, smallPrimary } from "./parts";

// La sezione «Server» di una task di server (area 8b, shape server-task.md):
// in testa al pannello, prima della descrizione. Il server è il contesto,
// Claude è il lavoro: qui stanno server, episodio, a che punto è la
// correzione, la proposta e l'avvio con le DUE CONDIZIONI sempre scritte
// sotto (anche a chi non può avviare). Piano, comandi e controllo finale
// vivono nella sezione Claude. Chi può avviare lo dice il livello dati
// (`startBlock`), mai la UI; l'ora dell'episodio è nel fuso di chi guarda.

const K = "taskDetail.server";
const linkClass =
  "font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

/** Gli stati dopo cui l'avvio dice «Start fix again». */
const AGAIN = new Set(["plan_rejected", "stopped", "not_resolved"]);
/** I blocchi d'avvio sotto cui le due condizioni restano scritte. */
const CONDITIONS_UNDER = new Set([
  "no_permission",
  "no_fix_access",
  "fix_access_unverified",
  "server_busy",
]);

export function ServerSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const info = useServerTaskInfo(task.id);
  const title = t(`${K}.title`);
  if (info.isError) {
    return (
      <Section title={title}>
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink">{t(`${K}.loadFailed`)}</span>
          <button type="button" className={ghostButton} onClick={() => void info.refetch()}>
            {t(`${K}.retry`)}
          </button>
        </div>
      </Section>
    );
  }
  if (info.isPending) {
    return (
      <Section title={title}>
        <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2 py-0.5">
          <span role="status" className="sr-only">
            {t(`${K}.loading`)}
          </span>
          <span className="h-2.5 w-3/5 rounded-sm bg-ink/8" />
          <span className="h-2.5 w-4/5 rounded-sm bg-ink/8" />
        </div>
      </Section>
    );
  }
  if (!info.data) return null;
  return <ServerBody task={task} info={info.data} />;
}

/** Un motivo in poche parole («Memory above 90%»). */
function reasonShort(reason: EpisodeReason, info: ServerTaskInfo, t: TFunction): string {
  switch (reason.kind) {
    case "cpu":
    case "memory":
    case "disk":
      return t(`${K}.reasonShort.${reason.kind}`, { threshold: reason.thresholdPct });
    case "check": {
      const name = info.checkNames[reason.checkId];
      return name ? t(`${K}.reasonShort.check`, { name }) : t(`${K}.reasonShort.checkGone`);
    }
    case "agent_silent":
      return t(`${K}.reasonShort.agent_silent`);
  }
}

/** «Oct 27 14:02», o solo l'ora se è oggi; nel fuso di chi guarda. */
const moment = (iso: string, lang: string) =>
  isToday(iso) ? clockLocal(iso, lang) : `${dayLocal(iso, lang)} ${clockLocal(iso, lang)}`;

function EpisodeLine({ episode, info }: { episode: ServerEpisode; info: ServerTaskInfo }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const all = episode.reasons.map((r) => reasonShort(r, info, t));
  const reasons =
    all.length > 1 ? t(`${K}.reasonsMore`, { first: all[0], count: all.length - 1 }) : all[0];
  const text = episode.recoveredAt
    ? t(`${K}.episodeClosed`, {
        reasons,
        from: moment(episode.startedAt, lang),
        // Lo stesso giorno dell'inizio: solo l'ora.
        to:
          dayLocal(episode.recoveredAt, lang) === dayLocal(episode.startedAt, lang)
            ? clockLocal(episode.recoveredAt, lang)
            : moment(episode.recoveredAt, lang),
      })
    : t(`${K}.episodeOpen`, { reasons, when: sinceWhen(episode.startedAt, lang) });
  return (
    <p title={all.length > 1 ? all.join(" · ") : undefined} className="text-sm text-ink-muted">
      {text}
    </p>
  );
}

/** Il piano aspetta chi guarda? Lo dice la conversazione (`canDecidePlan`). */
function useWaitsOnMe(conversationId: string | null): boolean {
  const detail = useConversation(conversationId ?? "").data;
  return conversationId !== null && (detail?.canDecidePlan ?? false);
}

function StateLine({ info, code }: { info: ServerTaskInfo; code: string }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const waitsOnMe = useWaitsOnMe(info.state === "plan_awaiting" ? info.fixConversationId : null);
  const s = info.state;
  let mark: ReactNode = null;
  let text: string;
  switch (s) {
    case "fix_planning":
    case "fixing":
      mark = <WorkingRing />;
      text = t(`${K}.states.${s}`, { code });
      break;
    case "plan_awaiting":
      if (waitsOnMe) {
        mark = (
          <span aria-hidden="true" className="grid size-3 shrink-0 place-items-center">
            <span className="size-2 rounded-full bg-ink" />
          </span>
        );
      }
      text = t(`${K}.states.${waitsOnMe ? "plan_awaiting_you" : "plan_awaiting"}`);
      break;
    case "plan_rejected":
      text = t(`${K}.states.plan_rejected`, {
        when: info.stateAt ? moment(info.stateAt, i18n.language) : "",
      });
      break;
    case "stopped": {
      // «stopped by» SOLO per lo Stop di una persona; altrimenti il motivo.
      const stop = info.stop;
      const name = people?.find((p) => p.id === stop?.byId)?.name;
      if (stop?.byId && name) text = t(`${K}.states.stoppedBy`, { name });
      else if (stop?.reason) text = t(`${K}.stoppedReasons.${stop.reason}`);
      else if (stop?.outcome === "failed" || stop?.outcome === "timed_out")
        text = t(`${K}.stoppedReasons.${stop.outcome}`);
      else text = t(`${K}.states.stopped`);
      break;
    }
    case "resolved":
      mark = (
        <span className="shrink-0 text-positive">
          <CheckGlyph size={12} />
        </span>
      );
      text = t(`${K}.states.resolved`);
      break;
    case "not_resolved":
      mark = (
        <span className="shrink-0 text-critical">
          <CrossGlyph size={12} />
        </span>
      );
      text = t(`${K}.states.not_resolved`);
      break;
    default:
      text = t(`${K}.states.${s}`);
  }
  return (
    <p
      data-server-task-state={s}
      aria-live="polite"
      className="flex min-h-6 items-center gap-2 text-md text-ink"
    >
      {mark}
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

/** «Suggested fix:» con la proposta di Claude, fino a 4 righe e «More». */
function Proposal({ text }: { text: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 4;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-sm">
      <div className={`min-w-0 text-ink ${!all && long ? "line-clamp-4" : ""}`}>
        <span className="font-semibold">{t(`${K}.suggested`)}</span>{" "}
        <Markdown source={text} className="inline [&>*]:inline" />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className={`${ghostButton} -ml-2 self-start`}
        >
          {all ? t(`${K}.less`) : t(`${K}.more`)}
        </button>
      )}
    </div>
  );
}

function ServerBody({ task, info }: { task: Task; info: ServerTaskInfo }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const project = useProjects().data?.find((p) => p.id === task.projectId)?.code ?? "";
  const code = info.server?.code ?? task.serverRef?.serverCode ?? "";
  const manageSsh = can(viewer, "servers.ssh.manage");
  const [confirming, setConfirming] = useState(false);
  const start = useStartServerFix();
  const toast = useToast();

  const run = () =>
    start.mutate(task.id, {
      onSuccess: () => {
        setConfirming(false);
        // Lo stato cambia sul posto; il pannello porta alla sezione Claude.
        requestAnimationFrame(() => {
          const status = document.querySelector<HTMLElement>(
            `[data-task-detail="${task.code}"] [data-claude-status]`,
          );
          const section = status?.closest("section");
          if (section) scrollPanelTo(section);
        });
      },
      onError: () => {
        setConfirming(false);
        toast.error(t(`${K}.startFailed`), { action: { label: t(`${K}.retry`), run } });
      },
    });

  const block = info.startBlock;
  const showConditions = info.server !== null && (block === null || CONDITIONS_UNDER.has(block));
  const accessLink = manageSsh && info.server && (
    <Link
      to="/p/$code/servers/$server"
      params={{ code: project, server: code }}
      search={{ section: "access" } as never}
      className={linkClass}
    >
      {t(`${K}.linkAccess`)}
    </Link>
  );

  let start_: ReactNode = null;
  if (info.server && block === null) {
    start_ = (
      <button
        type="button"
        className={`${smallPrimary} self-start`}
        disabled={start.isPending}
        data-start-fix
        onClick={() => setConfirming(true)}
      >
        {t(`${K}.${AGAIN.has(info.state) ? "startAgain" : "start"}`)}
      </button>
    );
  } else if (
    info.server &&
    block &&
    block !== "run_live" &&
    block !== "closed" &&
    block !== "not_server_task"
  ) {
    start_ = (
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
        <span>{t(`${K}.blocks.${block}`, { code, project })}</span>
        {(block === "no_fix_access" || block === "fix_access_unverified") && accessLink}
      </p>
    );
  }

  const analysis = info.analysis;
  const outcomeKey =
    analysis && analysis.outcome !== "diagnosed" && analysis.outcome !== "running"
      ? analysis.outcome
      : null;

  return (
    <Section title={t(`${K}.title`)}>
      {info.server ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-md text-ink">
          <span className="num font-semibold">{info.server.code}</span>
          <span className="min-w-0 truncate" title={info.server.name}>
            {info.server.name}
          </span>
          {info.health && (
            <>
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
                <HealthGlyph health={info.health.health} />
                {t(`servers.health.${info.health.health}`)}
              </span>
            </>
          )}
          <Link
            to="/p/$code/servers/$server"
            params={{ code: project, server: info.server.code }}
            aria-label={t(`${K}.openLabel`, { code: info.server.code })}
            className={`${ghostButton} ml-auto`}
          >
            {t(`${K}.open`)}
            <span aria-hidden="true">→</span>
          </Link>
        </p>
      ) : (
        <p className="text-md text-ink-muted">{t(`${K}.hidden`)}</p>
      )}
      {info.episode && <EpisodeLine episode={info.episode} info={info} />}
      <StateLine info={info} code={code} />

      {outcomeKey && <p className="text-sm text-ink">{t(`servers.now.work.${outcomeKey}`)}</p>}
      {analysis?.proposal && <Proposal text={analysis.proposal} />}
      {analysis?.conversationId && (
        <Link
          to="/claude/$id"
          params={{ id: analysis.conversationId }}
          className={`${linkClass} self-start text-sm`}
        >
          {t(`${K}.readAnalysis`)} <span aria-hidden="true">→</span>
        </Link>
      )}
      {info.state === "resolved" && <p className="text-sm text-ink-muted">{t(`${K}.closeHint`)}</p>}

      {(start_ || showConditions) && (
        <div className="flex min-w-0 flex-col gap-2 pt-1">
          {start_}
          {showConditions && (
            <ol className="flex flex-col gap-0.5 text-xs text-ink-muted">
              <li>{t(`${K}.conditionOne`, { project })}</li>
              <li>{t(`${K}.conditionTwo`, { code, project })}</li>
            </ol>
          )}
        </div>
      )}

      {confirming && (
        <Dialog
          title={t(`${K}.dialog.title`, { code })}
          width={440}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setConfirming(false)}
              >
                {t(`${K}.dialog.cancel`)}
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={start.isPending}
                data-confirm-start-fix
                onClick={run}
              >
                {t(`${K}.dialog.confirm`)}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">
            {t(`${K}.dialog.before`)}
            <strong className="font-semibold">{t(`${K}.dialog.strong`, { code })}</strong>
            {t(`${K}.dialog.after`)}
          </p>
        </Dialog>
      )}
    </Section>
  );
}
