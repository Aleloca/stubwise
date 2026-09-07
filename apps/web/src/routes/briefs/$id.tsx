import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../components/copy-button";
import { Markdown } from "../../components/markdown";
import { generateProjectBrief } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDate, formatDateTime } from "../../lib/format";
import { briefQueryOptions, projectQueryOptions } from "../../lib/queries";

const route = getRouteApi("/authed/briefs/$id");

/**
 * UN BRIEF SETTIMANALE (Fase 5): il resoconto della settimana per chi non legge
 * codice, per intero e in una pagina propria.
 *
 * Perché una pagina e non un pannello dentro la roadmap: il brief è la cosa che
 * si INOLTRA — a un responsabile, a un cliente, in una mail — e per inoltrare
 * serve un link stabile e un testo che si copia in un gesto. "Copia come testo"
 * porta via il MARKDOWN, non il testo renderizzato: è ciò che si incolla in
 * Slack, in una issue o in una mail senza perdere titoli ed elenchi.
 *
 * "Rigenera" è solo per un maintainer — è un run AI, e chi lo lancia spende —
 * mentre la copia resta a tutti: leggere e inoltrare non è un privilegio.
 */
export function BriefPage() {
  const { t } = useTranslation();
  const { id } = route.useParams();
  const queryClient = useQueryClient();

  const { data: brief } = useSuspenseQuery(briefQueryOptions(id));
  const { data: project } = useSuspenseQuery(projectQueryOptions(brief.projectId));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const regenerate = useMutation({
    mutationFn: () => generateProjectBrief(brief.projectId, { force: true }),
    onSuccess: (updated) => {
      // La risposta È la riga aggiornata (`queued`): scriverla in cache accende
      // subito lo stato "in corso" e con esso il polling di `briefQueryOptions`.
      queryClient.setQueryData(["briefs", "detail", id], updated);
    },
  });

  const period = t("projects:roadmap.briefPeriod", {
    from: formatDate(`${brief.periodStart}T00:00:00.000Z`),
    to: formatDate(`${brief.periodEnd}T00:00:00.000Z`),
  });

  return (
    <div className="page">
      <Link
        to="/projects/$projectId/roadmap"
        params={{ projectId: brief.projectId }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("projects:weeklyBrief.backToRoadmap")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t("projects:weeklyBrief.title")}</h1>
            <p className="mt-1 font-mono text-[12px] text-fg-muted">
              <span className="text-fg">{project.name}</span>
              <span className="text-fg-faint"> · {period}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {brief.summary && (
              <CopyButton text={brief.summary} label={t("projects:weeklyBrief.copy")} />
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending || brief.status === "queued" || brief.status === "running"}
                className="tap shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("projects:weeklyBrief.regenerate")}
              </button>
            )}
          </div>
        </div>
        {brief.finishedAt && (
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            {t("projects:weeklyBrief.generatedAt")} {formatDateTime(brief.finishedAt)}
          </p>
        )}
      </header>

      <div className="mt-6">
        <BriefBody brief={brief} />
      </div>
    </div>
  );
}

/**
 * Il corpo del brief, o il MOTIVO per cui non c'è.
 *
 * I tre casi senza testo sono distinti apposta: "sta arrivando" (in coda o in
 * generazione), "non è arrivato" (`failed`) e "non arriverà così com'è"
 * (l'istanza non ha un provider AI, quindi il brief è `done` ma vuoto). Una
 * pagina bianca li confonderebbe tutti e tre in "non funziona".
 */
function BriefBody({
  brief,
}: {
  brief: { status: string; summary: string | null };
}) {
  const { t } = useTranslation();

  if (brief.status === "queued" || brief.status === "running") {
    return <p className="text-[13px] text-fg-muted">{t("projects:weeklyBrief.pending")}</p>;
  }
  if (brief.status === "failed") {
    return <p className="text-[13px] text-danger">{t("projects:weeklyBrief.failed")}</p>;
  }
  if (!brief.summary?.trim()) {
    return <p className="text-[13px] text-fg-muted">{t("projects:weeklyBrief.noText")}</p>;
  }
  return <Markdown source={brief.summary} />;
}
