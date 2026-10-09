import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentSessionOutcomeSchema } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { RouteError } from "../../components/route-error";
import { SessionRow } from "../../components/agent-session/session-row";
import { isAgentSessionsUnavailable } from "../../lib/api";
import { useNow } from "../../lib/elapsed";
import { agentSessionsQueryOptions, projectsQueryOptions } from "../../lib/queries";

const OUTCOMES = agentSessionOutcomeSchema.options;

/**
 * `/agents`: «Al lavoro ora» e «Concluse». Usa `useQuery` e NON la suspense: un
 * server senza le rotte risponde 404 senza `code`, e deve dire «non disponibile
 * su questa istanza», non finire nell'errorComponent. Il filtro progetto va al
 * server (`?projectId=`, chiave di query diversa); quello sull'esito è sul
 * client, sull'elenco ricevuto (design §8.2).
 */
export function AgentsPage() {
  const { t } = useTranslation("agents");
  const now = useNow();
  const [projectId, setProjectId] = useState("");
  const [outcome, setOutcome] = useState("");
  // keepPreviousData: cambiando il filtro la chiave cambia, e senza di esso la
  // pagina (filtri compresi) si smonterebbe fino all'arrivo della risposta.
  const { data, error } = useQuery({
    ...agentSessionsQueryOptions(projectId ? { projectId } : undefined),
    placeholderData: keepPreviousData,
  });
  const { data: projects } = useQuery(projectsQueryOptions);

  const unavailable = error !== null && isAgentSessionsUnavailable(error);

  return (
    <div className="page mx-auto w-full max-w-5xl">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-[0.02em] text-fg uppercase">
          {t("title")}
        </h1>
        {!unavailable && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{t("subtitle")}</p>}
      </header>

      {unavailable ? (
        <p className="mt-6 text-sm text-fg-muted">{t("unavailable")}</p>
      ) : data === undefined && error !== null ? (
        <RouteError error={error} />
      ) : data === undefined ? null : (
        <>
          <section className="mt-6">
            <h2 className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
              {t("live")}
            </h2>
            {data.live.length === 0 ? (
              <p className="mt-2 font-mono text-[12px] text-fg-faint">{t("emptyLive")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line rounded-sm border border-line bg-ink-900">
                {data.live.map((s) => (
                  <SessionRow key={s.id} session={s} now={now} live />
                ))}
              </ul>
            )}
          </section>

          <section className="mt-8">
            <h2 className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
              {t("recent")}
            </h2>
            <div className="mt-2 flex flex-wrap gap-4 text-[12px] text-fg-muted">
              <label className="flex items-center gap-2">
                {t("filters.project")}
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="rounded-sm border border-line bg-ink-900 px-2 py-1 text-fg"
                >
                  <option value="">{t("filters.allProjects")}</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                {t("filters.outcome")}
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  className="rounded-sm border border-line bg-ink-900 px-2 py-1 text-fg"
                >
                  <option value="">{t("filters.allOutcomes")}</option>
                  {OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {t(`outcome.${o}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(() => {
              const recent = data.recent.filter(
                (s) => outcome === "" || (s.outcome ?? null) === outcome,
              );
              return recent.length === 0 ? (
                <p className="mt-2 font-mono text-[12px] text-fg-faint">{t("emptyRecent")}</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-sm border border-line bg-ink-900">
                  {recent.map((s) => (
                    <SessionRow key={s.id} session={s} now={now} live={false} />
                  ))}
                </ul>
              );
            })()}
          </section>
        </>
      )}
    </div>
  );
}
