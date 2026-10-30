import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { waitingText } from "../../components/InstanceBlock";
import { useTask } from "../../data/queries";
import type { ServerDetail, ServerEpisodeView } from "../../data/servers";
import { WorkingRing } from "../claude/conversation/parts";
import {
  clockLocal,
  dayKey,
  dayLocal,
  duration,
  isToday,
  reasonSentence,
  sinceWhen,
} from "./format";
import { HealthGlyph } from "./glyphs";

// Il riquadro «Now» in testa al dettaglio (shape servers.md §3): l'unico
// fondo della pagina. C'è solo con un episodio aperto, un rientro da meno
// di 24 ore o una task di server aperta. Dice da quando, perché (i motivi
// in frase) e chi ci lavora; senza accesso di lettura usabile dice che
// Claude non può guardare, e a chi gestisce gli accessi porta lì.
// L'ora del rientro è nel fuso di chi guarda.

const linkClass = "rounded-sm text-ink underline underline-offset-4 hover:decoration-2";

/** L'episodio di cui parla il riquadro: l'aperto, o l'ultimo rientrato. */
export function nowEpisode(server: ServerDetail): ServerEpisodeView | null {
  return server.episodes.find((e) => e.recoveredAt === null) ?? server.episodes[0] ?? null;
}

export function showsNow(server: ServerDetail): boolean {
  const h = server.health.health;
  return h === "down" || h === "trouble" || h === "recovered" || server.work !== "none";
}

/** Il codice di una task che apre il pannello sulla pagina, col titolo se c'è. */
function TaskLink({ code }: { code: string }) {
  const task = useTask(code).data;
  return (
    <Link
      to="."
      search={((prev: Record<string, unknown>) => ({ ...prev, task: code })) as never}
      className={linkClass}
    >
      <span className="num font-semibold">{code}</span>
      {task?.title ? ` ${task.title}` : ""}
    </Link>
  );
}

function WorkLine({
  server,
  episode,
}: {
  server: ServerDetail;
  episode: ServerEpisodeView | null;
}) {
  const { t } = useTranslation();
  const analysis = episode?.analysis ?? null;
  const taskCode = episode?.taskCode ?? server.workTaskCode;
  const line = (ring: boolean, text: string, extra?: ReactNode) => (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-md text-ink">
      {ring && <WorkingRing size={12} />}
      <span>{text}</span>
      {extra && (
        <>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          {extra}
        </>
      )}
    </p>
  );
  const session = (id: string) => (
    <Link to="/claude/$id" params={{ id }} className={linkClass}>
      {t("servers.now.openSession")}
    </Link>
  );
  const task = taskCode ? <TaskLink code={taskCode} /> : undefined;

  if (server.work === "fixing") return line(true, t("servers.now.work.fixing"), task);
  // Area 9b: nata ma ferma per la coda in pausa, senza anello (non sta lavorando).
  if (analysis?.outcome === "running" && episode?.analysisWaiting)
    return line(
      false,
      waitingText(
        t,
        episode.analysisWaiting,
        episode.analysisWaiting.reason === "queue_paused" ? episode.analysisWaiting.byName : "",
      ),
      session(analysis.conversationId),
    );
  if (analysis?.outcome === "running")
    return line(true, t("servers.now.work.analyzing"), session(analysis.conversationId));
  if (analysis?.outcome === "failed")
    return line(false, t("servers.now.work.failed"), session(analysis.conversationId));
  if (analysis) {
    const key = analysis.outcome === "diagnosed" ? "diagnosed" : analysis.outcome;
    if (!episode?.taskCode) return line(false, t("servers.now.work.hiddenTask"));
    return line(false, t(`servers.now.work.${key}`), task);
  }
  if (server.work === "diagnosis_ready" && task)
    return line(false, t("servers.now.work.diagnosed"), task);
  return null;
}

export function NowBox({ server }: { server: ServerDetail }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const episode = nowEpisode(server);
  const h = server.health;
  const open = episode && episode.recoveredAt === null ? episode : null;

  let title: string;
  if ((h.health === "down" || h.health === "trouble") && h.since) {
    title = t(`servers.now.${h.health}${dayKey(h.since)}`, { when: sinceWhen(h.since, lang) });
  } else if (episode?.recoveredAt) {
    const params = {
      time: clockLocal(episode.recoveredAt, lang),
      date: dayLocal(episode.recoveredAt, lang),
      duration: duration(Date.parse(episode.recoveredAt) - Date.parse(episode.startedAt), t),
    };
    title = t(
      isToday(episode.recoveredAt) ? "servers.now.recovered" : "servers.now.recoveredOn",
      params,
    );
  } else {
    title = t(`servers.health.${h.health}`);
  }
  const reasons = open ? h.reasons : (episode?.reasons ?? []);
  const noRead = !server.access.usable.read;
  const inTrouble = h.health === "down" || h.health === "trouble";
  const work = <WorkLine server={server} episode={episode} />;

  return (
    <section
      aria-label={t("servers.now.label")}
      data-now
      className="run-open flex flex-col gap-3 rounded-lg border border-rule bg-ink/4 px-5 py-4"
    >
      <div className="flex items-start gap-2.5">
        <span className="pt-0.5">
          <HealthGlyph health={episode?.recoveredAt && !inTrouble ? "recovered" : h.health} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p
            aria-live="polite"
            className="num text-lg font-semibold text-ink [overflow-wrap:anywhere]"
          >
            {title}
          </p>
          {reasons.length > 0 && (
            <ul aria-label={t("servers.now.reasons")} className="flex flex-col gap-0.5">
              {reasons.map((r, i) => (
                <li key={i} className="num text-md text-ink-muted">
                  {reasonSentence(r, server.checks, t, lang, open ? open.startedAt : null)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {work}
      {/* Un orfano (area 9b) non ha staging né produzioni: «Staging only» sarebbe
          falso, e che Claude lavori solo dentro un progetto lo dice la testata. */}
      {!server.orphan && server.analysisProject === null && inTrouble && (
        <p className="text-md text-ink-muted">{t("servers.stagingOnly")}</p>
      )}
      {inTrouble &&
        noRead &&
        !server.orphan &&
        server.analysisProject !== null &&
        server.work === "none" &&
        !episode?.analysis && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-md text-ink">{t("servers.now.noAccess")}</p>
            {server.access.canManage && (
              // La stessa pagina, dal progetto o dall'Amministrazione: solo `?section=`.
              <Link
                to="."
                search={
                  ((prev: Record<string, unknown>) => ({ ...prev, section: "access" })) as never
                }
                className={linkClass}
              >
                {t("servers.now.linkAccess")}
              </Link>
            )}
          </div>
        )}
      {server.productionProjects.length > 1 && server.analysisProject?.code && (
        <p className="text-sm text-ink-muted">
          {t("servers.now.primary", { code: server.analysisProject.code })}
        </p>
      )}
    </section>
  );
}
