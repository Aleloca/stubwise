import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { meQueryOptions } from "../lib/auth";
import { generateDocs, resumeDocs } from "../lib/docs-api";
import type { DocStatus } from "../lib/docs-api";
import type { DocJobStatus } from "@stubwise/shared";
import { formatRelativeTime } from "../lib/format";
import { docsKeys, docStatusQueryOptions } from "../lib/queries";

/**
 * Pannello stato/trigger generazione (M7.4), montato nell'header dell'aside
 * dello spazio. Mostra lo stato dell'ultima generazione (data/commit/costo) e,
 * SOLO per gli admin, il bottone "Genera documentazione".
 *
 * Polling: la query dello stato (`docStatusQueryOptions`) abilita un
 * `refetchInterval` adattivo (vedi `statusRefetchInterval`) finché c'è un job
 * attivo (queued/running) così la UI riflette l'avanzamento senza websocket;
 * appena il job termina il refetch si ferma. Al click invalidiamo subito lo
 * stato per partire dal job appena accodato. Approccio volutamente semplice
 * (no streaming).
 */

/** Stati di job "attivi": finché uno è in corso, la status query fa polling. */
const ACTIVE_JOB_STATUSES: DocJobStatus[] = ["queued", "running"];

/**
 * Intervallo di polling della status query in base allo stato corrente.
 * Adattivo: 4s finché un job è attivo (queued/running); con la generazione
 * in pausa (limite del provider) la pausa può durare ORE → si rallenta a 60s,
 * anche a job già terminato (vedi sotto).
 * Niente spegnimento totale in pausa: `refetchOnWindowFocus` è disattivato
 * globalmente, quindi senza polling il badge resterebbe stantio per sempre
 * dopo che il resume poller riprende la generazione. Con i 60s il badge si
 * auto-corregge entro un minuto dalla ripresa e, tornata la generazione
 * "running", si rientra da soli nel polling a 4s. Job terminato → stop.
 */
export function statusRefetchInterval(data: DocStatus | undefined): number | false {
  // Pausa: può coesistere con un trigger job già `succeeded` (il trigger si
  // chiude al seeding del DAG): il check viene PRIMA del gate sul job. 60s
  // bastano perché il badge si auto-corregga dopo la ripresa del poller.
  if (data?.generation?.status === "paused") return 60_000;
  if (!data?.latestJob || !ACTIVE_JOB_STATUSES.includes(data.latestJob.status)) return false;
  return 4000;
}

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
    refetchInterval: (query) => statusRefetchInterval(query.state.data),
  });

  const generation = useMutation({
    mutationFn: () => generateDocs(projectId),
    onSuccess: async () => {
      // Riflette subito lo stato "queued/running" del job appena (ri)avviato.
      await queryClient.invalidateQueries({ queryKey: docsKeys.status(projectId) });
    },
  });

  const resume = useMutation({
    mutationFn: () => resumeDocs(projectId),
    // Invalida anche in errore: un 409 generation_not_paused = il resume
    // poller (o un altro admin) l'ha già ripresa: lo stato in cache è
    // stantio, va rinfrescato comunque.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: docsKeys.status(projectId) });
    },
  });

  const job = status?.latestJob ?? null;
  const gen = status?.generation ?? null;
  const pinnedProvider = status?.pinnedProvider ?? null;
  const jobActive = job !== null && ACTIVE_JOB_STATUSES.includes(job.status);
  const isPaused = gen?.status === "paused";

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

      {jobActive && !isPaused && (
        <p className="mt-2 font-mono text-[11px] text-signal" role="status">
          {t("docs:generation.jobRunning")}
        </p>
      )}
      {isPaused && (
        <>
          <p className="mt-2 font-mono text-[11px] text-signal" role="status">
            {t("docs:generation.paused")}
          </p>
          {isAdmin && (
            <button
              type="button"
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
              className="mt-3 w-full rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.06em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim"
            >
              {resume.isPending ? t("docs:generation.resuming") : t("docs:generation.resume")}
            </button>
          )}
          {resume.isError && (
            // Resume fallito (es. 500): senza feedback il bottone tornerebbe
            // cliccabile col badge fermo. Nel caso 409 "già ripresa"
            // l'invalidazione fa uscire dallo stato paused e l'alert sparisce
            // con tutto il blocco.
            <p className="mt-2 font-mono text-[11px] text-danger" role="alert">
              {t("docs:generation.resumeError")}
            </p>
          )}
        </>
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
