import { featureIntegrated } from "../../data/integration";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WithWho } from "../../components/InstanceBlock";
import { useAiBlock, useTask } from "../../data/queries";
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
// la diagnosi sarà senza letture SSH (Claude guarda lo stesso), e a chi
// gestisce gli accessi porta lì.
// L'ora del rientro è nel fuso di chi guarda. L'analisi è del server (area
// 8, F4b-4): nessun progetto «dell'analisi» prima; a fine analisi, se il
// progetto non si è potuto dire, la riga lo dice col perché.

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
  // La sessione solo a chi la può leggere (il livello dati dà l'id, o `null`).
  const session = (id: string | null) =>
    id === null ? undefined : (
      <Link to="/claude/$id" params={{ id }} className={linkClass}>
        {t("servers.now.openSession")}
      </Link>
    );
  const task = taskCode ? <TaskLink code={taskCode} /> : undefined;

  if (server.work === "fixing") return line(true, t("servers.now.work.fixing"), task);
  if (analysis?.outcome === "running")
    return line(true, t("servers.now.work.analyzing"), session(analysis.sessionId));
  if (analysis?.outcome === "failed")
    return line(false, t("servers.now.work.failed"), session(analysis.sessionId));
  // Il progetto non si è potuto dire: nessuna task, e il perché (F4b-4).
  if (analysis?.attribution?.kind === "undetermined")
    return line(
      false,
      t("servers.now.work.undetermined", {
        reason: t(`servers.attribution.${analysis.attribution.reason}`, {
          defaultValue: t("servers.attribution.other"),
        }),
      }),
      session(analysis.sessionId),
    );
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
  // Le frasi dei motivi; uno che l'app non conosce non lascia una riga vuota (review F4a, I3).
  const reasons = (open ? h.reasons : (episode?.reasons ?? [])).flatMap(
    (r) => reasonSentence(r, server.checks, t, lang, open ? open.startedAt : null) ?? [],
  );
  const noRead = !server.access.usable;
  const inTrouble = h.health === "down" || h.health === "trouble";
  const work = <WorkLine server={server} episode={episode} />;
  // La frase del budget vale finché il budget è esaurito adesso: alzato, non
  // la si dice più (il blocco di adesso, non quello dell'allarme; ri-revisione m3).
  const budgetNow = useAiBlock(null).data?.reason === "monthly_budget";

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
              {reasons.map((sentence, i) => (
                <li key={i} className="num text-md text-ink-muted">
                  {sentence}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {work}
      {/* Un orfano (area 9b) non ha staging né produzioni: «Staging only» sarebbe
          falso, e che Claude lavori solo dentro un progetto lo dice la testata. */}
      {featureIntegrated("servers-analysis") && !server.orphan && !server.alerting && inTrouble && (
        <p className="text-md text-ink-muted">{t("servers.stagingOnly")}</p>
      )}
      {/* Senza l'accesso di lettura Claude guarda lo stesso (decisione del
          maintainer, 15 nov 2026, come il worker): la diagnosi è senza letture
          SSH, e chi gestisce gli accessi può collegarlo da qui. */}
      {featureIntegrated("servers-analysis") &&
        // Senza l'SSH integrato (build app) lo stato dell'accesso non si sa: niente frase.
        featureIntegrated("servers-ssh") &&
        inTrouble &&
        noRead &&
        !server.orphan &&
        server.alerting && (
          <div data-no-ssh-reads className="flex flex-wrap items-center gap-3">
            <p className="text-md text-ink">
              {t(
                server.access.state === "not_linked" || server.access.state === "revoked"
                  ? "servers.now.noSshReads"
                  : "servers.now.noSshReadsUnusable",
              )}
            </p>
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
      {/* Col budget raggiunto all'allarme l'analisi non è partita: lo si dice,
          col «Who?» di chi alza il budget (shape EF, revisione finale M4). */}
      {/* L'analisi spenta in Amministrazione → AI all'allarme (R0-C). */}
      {open?.analysisBlocked === "disabled" && !open.analysis && (
        <p data-analysis-off className="text-md text-pretty text-ink">
          {t("servers.now.analysisOff")}
        </p>
      )}
      {open?.analysisBlocked === "monthly_budget" && !open.analysis && budgetNow && (
        <p data-ai-block="monthly_budget" className="text-md text-pretty text-ink">
          <WithWho text={t("servers.now.noBudget")} />
        </p>
      )}
    </section>
  );
}
