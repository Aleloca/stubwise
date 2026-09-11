import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveNextStep, type BacklogItemStatus } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { convertBacklogItem } from "../lib/api";
import { backlogKeys, ticketJobsQueryOptions, ticketKeys } from "../lib/queries";

/**
 * La riga del PASSO SUCCESSIVO (fase 7, design §4): dove sta la voce nel
 * percorso idea → modifica pronta, e cosa si può fare adesso. **Deterministica
 * per costruzione**: derivata SOLO da voce + ticket + job, MAI da un modello —
 * "una frase sbagliata su cosa fare adesso è peggio di nessuna frase" (design,
 * "Rischi e decisioni prese nel piano"). Chi è tentato di far scrivere questa
 * riga a un agente si fermi e lo scriva a un maintainer prima di procedere.
 *
 * App M1 (11 set 2026): `deriveNextStep` (con `NextStepKind`/`NextStepInput`)
 * è SPOSTATA in `@stubwise/shared` (`next-step.ts`) — comportamento
 * identico, stessi test, spostati anche loro — sullo stesso precedente di
 * `workStateFor`: logica pura condivisa fra sito e app, non ancora cablata
 * nell'app (è M3). Qui resta solo il componente React.
 */
export type { NextStepKind } from "@stubwise/shared";

export function WorkNextStep({
  itemId,
  itemStatus,
  ticketId,
  ticketNumber,
}: {
  itemId: string;
  itemStatus: BacklogItemStatus;
  /** Ticket "converted_to" collegato, o null se la voce non è ancora convertita. */
  ticketId: string | null;
  ticketNumber: number | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Job del ticket collegato: SOLO se la voce è convertita (query condizionale,
  // stessa chiave/polling della pagina ticket — nessuna query duplicata se
  // l'operatore apre anche quella). `enabled: false` finché non c'è un ticket:
  // niente richiesta a vuoto per una voce non ancora convertita.
  const { data: jobs } = useQuery({
    ...ticketJobsQueryOptions(ticketId ?? ""),
    enabled: ticketId !== null,
  });
  const latestJobStatus = ticketId === null ? null : (jobs?.[0]?.status ?? null);

  const step = deriveNextStep({ itemStatus, ticketId, latestJobStatus });

  // Stesso effetto collaterale del bottone "Converti" in ActionsPanel: il
  // dettaglio invalidato riporta lo stato "converted" E il nuovo link
  // "converted_to" (da cui questo componente ricava `ticketId`) in un colpo
  // solo, senza un patch manuale della cache che li scriverebbe a metà.
  const convertMutation = useMutation({
    mutationFn: () => convertBacklogItem(itemId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });

  if (step === null) return null;

  return (
    <div
      role="status"
      className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-sm border border-line bg-ink-900 px-4 py-2.5"
    >
      <p className="text-sm text-fg">{t(`backlog:nextStep.${step}`)}</p>
      {step === "readyToConvert" && (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={convertMutation.isPending}
            onClick={() => convertMutation.mutate()}
            className="shrink-0 rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
          >
            {convertMutation.isPending ? t("backlog:actions.converting") : t("backlog:actions.convert")}
          </button>
          {convertMutation.isError && (
            <span role="alert" className="font-mono text-[11px] text-danger">
              {convertMutation.error.message}
            </span>
          )}
        </div>
      )}
      {step !== "clarify" && step !== "readyToConvert" && ticketId !== null && (
        <Link
          to="/tickets/$id"
          params={{ id: ticketId }}
          className="shrink-0 rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
        >
          {ticketNumber !== null ? `${t("backlog:nextStep.goToTicket")} #${ticketNumber}` : t("backlog:nextStep.goToTicket")}
        </Link>
      )}
    </div>
  );
}
