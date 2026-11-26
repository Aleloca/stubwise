import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useServerFollowsAnalysis, useStartServerAnalysis } from "../../data/queries";
import type { ServerAnalysisView, ServerDetail } from "../../data/servers";
import { WorkingRing } from "../claude/conversation/parts";
import { smallSecondary } from "../task/parts";

// «Ask Claude to look into it» (area 8, F4b, R0-A2): l'analisi a mano del
// server, per chi ha `servers.operate` in un progetto il cui ambiente lo usa
// (staging compreso: un server di solo staging non si analizza da solo). Il
// bottone c'è solo quando si può (`canStartAnalysis`: il permesso, l'accesso
// di lettura usabile, nessuna analisi in corso). Sotto, l'ultima analisi a
// mano: chi l'ha chiesta, e dove sta la diagnosi. Sessione e diagnosi solo a
// chi le può leggere (`sessionId`, il livello dati lo decide).

const linkClass = "rounded-sm text-ink underline underline-offset-4 hover:decoration-2";

const ERRORS = new Set(["analysis_running", "access", "monthly_budget", "forbidden"]);

function Line({ ring, text, extra }: { ring: boolean; text: string; extra?: ReactNode[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-md text-ink">
      {ring && <WorkingRing size={12} />}
      <span>{text}</span>
      {extra?.map((x, i) => (
        <span key={i} className="flex items-center gap-x-2">
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          {x}
        </span>
      ))}
    </p>
  );
}

function AnalysisLine({ analysis }: { analysis: ServerAnalysisView }) {
  const { t } = useTranslation();
  // R.1414: chi l'ha avviata e chi guarda non conosce: «Someone».
  const name = analysis.startedBy ? analysis.startedBy.name || t("chat.message.someone") : "";
  const session =
    analysis.sessionId === null ? null : (
      <Link to="/claude/$id" params={{ id: analysis.sessionId }} className={linkClass}>
        {t("servers.now.openSession")}
      </Link>
    );
  const task =
    analysis.taskCode === null ? null : (
      <Link
        to="."
        search={
          ((prev: Record<string, unknown>) => ({ ...prev, task: analysis.taskCode })) as never
        }
        className={linkClass}
      >
        <span className="num font-semibold">{analysis.taskCode}</span>
      </Link>
    );
  const extra = (...xs: (ReactNode | null)[]) => xs.filter((x) => x !== null);

  // Bloccata prima di partire (build app: budget, analisi spenta, tetto): il perché.
  if (analysis.blockedBy)
    return <Line ring={false} text={t(`servers.manual.blocked.${analysis.blockedBy}`, { name })} />;
  if (analysis.outcome === "running")
    return <Line ring text={t("servers.manual.running", { name })} extra={extra(session)} />;
  if (analysis.attribution?.kind === "undetermined")
    return (
      <Line
        ring={false}
        text={t("servers.manual.undetermined", {
          reason: t(`servers.attribution.${analysis.attribution.reason}`, {
            defaultValue: t("servers.attribution.other"),
          }),
        })}
        extra={extra(session)}
      />
    );
  if (analysis.outcome === "failed")
    return <Line ring={false} text={t("servers.manual.failed", { name })} extra={extra(session)} />;
  return (
    <>
      <Line
        ring={false}
        text={t(`servers.manual.${analysis.outcome}`, { name })}
        extra={extra(task, session)}
      />
      {/* La task in un progetto che chi guarda non vede: si dice, senza il codice. */}
      {analysis.taskCode === null && analysis.attribution?.kind === "attributed" && (
        <p className="text-sm text-ink-muted">{t("servers.manual.hiddenTask")}</p>
      )}
    </>
  );
}

export function ManualAnalysis({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const start = useStartServerAnalysis();
  const [error, setError] = useState<string | null>(null);
  const last = server.manualAnalysis;
  useServerFollowsAnalysis(server.code, last?.outcome === "running");
  if (!server.canStartAnalysis && !last) return null;

  return (
    <section
      aria-label={t("servers.manual.label")}
      data-manual-analysis
      className="flex max-w-[720px] flex-col gap-2"
    >
      {last && <AnalysisLine analysis={last} />}
      {server.canStartAnalysis && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={smallSecondary}
            disabled={start.isPending}
            onClick={() => {
              setError(null);
              start.mutate(server.code, {
                onError: (e) => {
                  const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
                  setError(t(`servers.manual.errors.${ERRORS.has(what) ? what : "generic"}`));
                },
              });
            }}
          >
            {t("servers.manual.start")}
          </button>
          <p className="text-sm text-pretty text-ink-muted">{t("servers.manual.hint")}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </section>
  );
}
