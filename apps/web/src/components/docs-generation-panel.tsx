import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { meQueryOptions } from "../lib/auth";
import { generateDocs } from "../lib/docs-api";
import type { DocJobStatus } from "@stubwise/shared";
import { formatRelativeTime } from "../lib/format";
import { docsKeys, docStatusQueryOptions } from "../lib/queries";

/**
 * Pannello stato/trigger generazione (M7.4), montato nell'header dell'aside
 * dello spazio. Mostra lo stato dell'ultima generazione (data/commit/costo) e,
 * SOLO per gli admin, il bottone "Genera documentazione".
 *
 * Polling: la query dello stato (`docStatusQueryOptions`) abilita un
 * `refetchInterval` di 4s finché c'è un job attivo (queued/running) così la UI
 * riflette l'avanzamento senza websocket; appena il job termina il refetch si
 * ferma. Al click invalidiamo subito lo stato per partire dal job appena
 * accodato. Approccio volutamente semplice (no streaming).
 */

/** Stati di job "attivi": finché uno è in corso, la status query fa polling. */
const ACTIVE_JOB_STATUSES: DocJobStatus[] = ["queued", "running"];

const JOB_STATUS_KEY: Record<DocJobStatus, string> = {
  queued: "docs:generation.statusQueued",
  running: "docs:generation.statusRunning",
  succeeded: "docs:generation.statusSucceeded",
  failed: "docs:generation.statusFailed",
  held: "docs:generation.statusHeld",
};

export function DocsGenerationPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const { data: status } = useQuery({
    ...docStatusQueryOptions(projectId),
    // Polling adattivo: ricarica ogni 4s solo se un job è ancora attivo.
    refetchInterval: (query) =>
      query.state.data?.latestJob &&
      ACTIVE_JOB_STATUSES.includes(query.state.data.latestJob.status)
        ? 4000
        : false,
  });

  const generation = useMutation({
    mutationFn: () => generateDocs(projectId),
    onSuccess: async () => {
      // Riflette subito lo stato "queued/running" del job appena (ri)avviato.
      await queryClient.invalidateQueries({ queryKey: docsKeys.status(projectId) });
    },
  });

  const job = status?.latestJob ?? null;
  const gen = status?.generation ?? null;
  const pinnedProvider = status?.pinnedProvider ?? null;
  const jobActive = job !== null && ACTIVE_JOB_STATUSES.includes(job.status);

  return (
    <section className="mb-4 rounded-sm border border-line bg-ink-900 p-3">
      <h2 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
        {t("docs:generation.title")}
      </h2>

      <dl className="mt-2 flex flex-col gap-1 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase">
            {t("docs:generation.lastStatus")}
          </dt>
          <dd className="text-fg-muted">
            {job ? t(JOB_STATUS_KEY[job.status]) : t("docs:generation.statusNever")}
          </dd>
        </div>
        {gen?.finishedAt && (
          <div className="text-right font-mono text-[11px] text-fg-faint">
            {t("docs:generation.lastGenerated", {
              date: formatRelativeTime(gen.finishedAt),
            })}
            {gen.commitSha
              ? ` · ${t("docs:generation.atCommit", { commit: gen.commitSha.slice(0, 7) })}`
              : ""}
          </div>
        )}
        {gen?.cost && (
          <div className="text-right font-mono text-[11px] text-fg-faint">
            {t("docs:generation.cost", { cost: gen.cost })}
          </div>
        )}
        {pinnedProvider && (
          // Provider bloccato della generazione corrente: in automatico (primo
          // abilitato) `pinnedProvider` è null e questa riga non compare.
          <div className="text-right font-mono text-[11px] text-fg-faint">
            {t("docs:generation.providerPinned", { label: pinnedProvider.label })}
          </div>
        )}
      </dl>

      {jobActive && (
        <p className="mt-2 font-mono text-[11px] text-signal" role="status">
          {t("docs:generation.jobRunning")}
        </p>
      )}
      {job?.status === "failed" && !jobActive && (
        <p className="mt-2 font-mono text-[11px] text-danger" role="status">
          {t("docs:generation.jobFailed")}
        </p>
      )}
      {(job?.status === "failed" || job?.status === "held") && job.error && (
        // Motivo dell'ultimo job non riuscito o trattenuto: per il `held` è il
        // motivo del blocco (es. tetto di costo superato), per il `failed` il
        // messaggio d'errore. Senza questo l'utente vedeva solo "fallita/in
        // attesa" senza capire il perché.
        <p className="mt-1 text-[11px] text-fg-muted" role="status">
          {t("docs:generation.jobReason", { reason: job.error })}
        </p>
      )}

      {isAdmin && (
        <button
          type="button"
          onClick={() => generation.mutate()}
          disabled={generation.isPending || jobActive}
          className="mt-3 w-full rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.06em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim"
        >
          {generation.isPending ? t("docs:generation.generating") : t("docs:generation.generate")}
        </button>
      )}
      {generation.error && (
        <p className="mt-2 font-mono text-[11px] text-danger" role="alert">
          {t("docs:generation.error")}
        </p>
      )}
    </section>
  );
}
