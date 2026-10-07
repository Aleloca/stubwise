import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, postRunAi, requestCorrection, type PrCycle } from "../lib/api";
import { PR_CYCLE_TONE_CLASS, prCycleLineFor } from "../lib/pr-cycle-line";
import { ticketKeys } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

interface PrCycleRowProps {
  ticketId: string;
  repositoryId: string;
  cycle: PrCycle;
}

/** Tetto della nota, lo stesso di `requestCorrectionBodySchema` lato server. */
const NOTE_MAX_LENGTH = 4000;

/**
 * Errore della ripresa: due codici hanno un testo PROPRIO del ciclo, letti dal
 * `code` e mai dallo status (anche `job_in_flight` è un 409, e lì il ticket
 * non va ricaricato). Il resto passa da `translateApiError` come ovunque.
 */
function resumeErrorText(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (error.code === "correction_not_held") return t("tickets:cycle.correctionNotHeld");
    if (error.code === "needs_maintainer") return t("tickets:cycle.needsMaintainer");
  }
  return translateApiError(error, t);
}

/**
 * Sotto una PR del ticket: la riga di stato del ciclo review → correzione, il
 * bottone "Chiedi modifiche" con una nota facoltativa (design §9) e, per
 * una correzione ferma, "Riprendi" (G5).
 *
 * Tutto ciò che mostra lo ha DERIVATO il server (`cycle`), bottoni compresi:
 * `canRequestCorrection` e `canResume` si leggono, non si ricostruiscono da
 * stato e ruolo — la stessa regola di `canMerge`, perché l'app non possa dire
 * una cosa diversa. Il server resta comunque l'autorità: un 409 arrivato nel
 * frattempo si mostra così com'è.
 *
 * Due passi (bottone → nota → conferma) e non un click secco: una correzione
 * spende un run dell'agente, e la nota è il momento di dirgli cosa guardare.
 *
 * ⚠️ Va keyato su ticket+repository: tiene stato locale (modulo aperto, nota,
 * esito delle mutazioni) seminato da quell'identità, e una pagina che cambia
 * ticket senza smontarsi (TanStack Router non rismonta sulla stessa rotta)
 * porterebbe la nota di un ticket sotto la PR di un altro.
 */
export function PrCycleRow({ ticketId, repositoryId, cycle }: PrCycleRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  // Il ciclo (riga di stato e bottoni) sta nel dettaglio; il job nella
  // timeline AI e nel feed.
  const invalidateTicket = () => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(ticketId) });
  };

  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = note.trim();
      return requestCorrection(ticketId, repositoryId, trimmed ? { note: trimmed } : {});
    },
    onSuccess: () => {
      setOpen(false);
      setNote("");
      invalidateTicket();
    },
  });

  // ⚠️ DIFESA NEL PUNTO DI LETTURA: `lib/api.ts` fa un cast, non un parse, e
  // un server più vecchio del bundle non manda i due campi. Senza `heldJobId`
  // il bottone NON si offre: run-ai senza `resumeCorrectionJobId` non dice
  // quale correzione riprendere, e su una correzione nel frattempo chiusa
  // avvierebbe un fix completo nuovo (G5).
  const canResume = cycle.canResume ?? false;
  // Il blocco lo DERIVA il server (`isAdoptedBranchProtected`): qui si legge,
  // `?? null` perché un server più vecchio non lo manda.
  const branchProtected = (cycle.blockedReason ?? null) === "adopted_branch_protected";
  const heldJobId = cycle.heldJobId ?? null;
  const resumeJobId = canResume ? heldJobId : null;

  const resumeMutation = useMutation({
    mutationFn: (jobId: string) => postRunAi(ticketId, { resumeCorrectionJobId: jobId }),
    onSuccess: invalidateTicket,
    onError: (error) => {
      // La correzione non è più quella ferma (annullata, riconciliata, già
      // ripartita): la schermata è vecchia, si ricarica il ticket. Il server
      // non ha scritto niente.
      if (error instanceof ApiError && error.code === "correction_not_held") invalidateTicket();
    },
  });

  const line = prCycleLineFor(cycle);
  const text = line.segments.map((segment) => t(segment.key, segment.params)).join(" · ");
  const noteId = `pr-cycle-note-${repositoryId}`;
  const busy = mutation.isPending || resumeMutation.isPending;

  return (
    <div className="flex basis-full flex-col gap-2" data-testid={`pr-cycle-${repositoryId}`}>
      <div className="flex flex-wrap items-center gap-3">
        {/* `min-w-0 wrap-anywhere`: la riga può contenere l'email del
            richiedente, che senza punti di rottura su 320px allargherebbe la
            pagina (scroll orizzontale). */}
        <span
          className={`min-w-0 font-mono text-[11px] wrap-anywhere ${PR_CYCLE_TONE_CLASS[line.tone]}`}
        >
          {text}
        </span>
        {!open && (
          <button
            type="button"
            disabled={!cycle.canRequestCorrection || busy}
            onClick={() => {
              mutation.reset();
              resumeMutation.reset();
              setOpen(true);
            }}
            className="rounded-sm border border-signal-dim px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-signal uppercase transition-colors hover:border-signal hover:bg-signal/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("tickets:cycle.apply")}
          </button>
        )}
        {resumeJobId !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              mutation.reset();
              resumeMutation.mutate(resumeJobId);
            }}
            className="rounded-sm border border-signal-dim px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-signal uppercase transition-colors hover:border-signal hover:bg-signal/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resumeMutation.isPending ? t("tickets:cycle.resuming") : t("tickets:cycle.resume")}
          </button>
        )}
      </div>
      {branchProtected && (
        <p className="min-w-0 font-mono text-[11px] wrap-anywhere text-signal" data-testid="pr-cycle-blocked">
          {t("tickets:cycle.blockedBranchProtected")}
        </p>
      )}
      {open && (
        <div>
          <label
            htmlFor={noteId}
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("tickets:cycle.noteLabel")}
          </label>
          <textarea
            id={noteId}
            rows={3}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            disabled={mutation.isPending}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("tickets:cycle.notePlaceholder")}
            className="mt-1 w-full rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 text-sm text-fg transition-colors focus-visible:border-signal-dim"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="rounded-sm bg-signal px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
            >
              {mutation.isPending ? t("tickets:cycle.confirming") : t("tickets:cycle.confirm")}
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                // L'errore parlava di QUESTO invio: chiuso il modulo, sparisce
                // con lui invece di restare appeso sotto la riga.
                mutation.reset();
                setOpen(false);
              }}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("tickets:cycle.cancel")}
            </button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-fg-muted">{t("tickets:cycle.hint")}</p>
        </div>
      )}
      {mutation.isError && (
        <span role="alert" className="min-w-0 font-mono text-[12px] wrap-anywhere text-danger">
          {translateApiError(mutation.error, t)}
        </span>
      )}
      {resumeMutation.isError && (
        <span role="alert" className="min-w-0 font-mono text-[12px] wrap-anywhere text-danger">
          {resumeErrorText(resumeMutation.error, t)}
        </span>
      )}
    </div>
  );
}
