import { ApiError } from "@stubwise/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { useIsOnline } from "./inbox-mutations";
import { projectsPulseKey, ticketKeys, workKeys } from "./query-keys";

/**
 * La frase per un rifiuto delle due azioni sotto una PR — «Chiedi
 * modifiche» (`POST /api/tickets/:id/repositories/:repositoryId/corrections`)
 * e «Riprendi» (run-ai con `resumeCorrectionJobId`, G5) —, una per `code`.
 *
 * ⚠️ **Decide il `code`, MAI lo status**: `correction_in_flight`,
 * `job_in_flight` e `correction_not_held` sono tutti 409 e dicono cose
 * diverse. Un 409 con un `code` sconosciuto è un errore generico, non una
 * delle frasi qui sotto. Unica eccezione voluta: lo status 0 (o un errore
 * che non è nemmeno un `ApiError`) è la rete, col testo dell'app — chi ha
 * premuto deve sapere se riprovare ha senso.
 *
 * `needs_maintainer` e `correction_not_held` hanno il testo del CICLO
 * (`mobile.work.pr.cycle.*`), come `resumeErrorText` del web: nessun
 * duplicato in `errors.*`. I codici delle due rotte non si sovrappongono,
 * quindi una funzione sola basta a entrambe le mutazioni.
 */
export function describeCorrectionError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError) || error.status === 0) return t("mobile.work.pr.errors.network");
  switch (error.code) {
    case "correction_in_flight":
      return t("mobile.work.pr.errors.correctionInFlight");
    case "job_in_flight":
      return t("mobile.work.pr.errors.jobInFlight");
    case "pr_not_open":
      return t("mobile.work.pr.errors.prNotOpen");
    case "not_stubwise_pr":
      return t("mobile.work.pr.errors.notStubwisePr");
    case "pr_not_found":
      return t("mobile.work.pr.errors.prNotFound");
    case "needs_maintainer":
      return t("mobile.work.pr.cycle.needsMaintainer");
    case "correction_not_held":
      return t("mobile.work.pr.cycle.correctionNotHeld");
    default:
      return t("mobile.work.pr.errors.generic");
  }
}

/**
 * I rifiuti della richiesta di correzione che dicono «la schermata è
 * vecchia»: la PR non è più quella che la riga mostrava, o c'è già lavoro in
 * corso. Si rilegge il lavoro del ticket, così la riga di stato lo dice subito
 * e il bottone si spegne invece di restare acceso fino allo `staleTime`.
 * Elencati per `code`, non presi da «ogni 409».
 */
const REQUEST_STALE_CODES: ReadonlySet<string> = new Set([
  "correction_in_flight",
  "job_in_flight",
  "pr_not_open",
  "not_stubwise_pr",
  "pr_not_found",
]);

export interface CorrectionInput {
  repositoryId: string;
  /** Già ripulita da chi chiama: `undefined` = nessuna nota. */
  note?: string;
}

function useInvalidateAfterCorrection(ticketId: string) {
  const queryClient = useQueryClient();
  return {
    /** Al successo: il lavoro del ticket, gli elenchi dei ticket e il polso. */
    all: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectsPulseKey });
    },
    /** Su un rifiuto che dice «schermata vecchia»: solo l'albero del ticket. */
    work: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
    },
  };
}

/**
 * «CHIEDI MODIFICHE» DALL'APP (30 set 2026, design «correzioni post-PR» §9):
 * la stessa rotta del bottone del web.
 *
 * Gemella di `useRelease` e non un `useTicketAction`, per UNA ragione: il
 * pannello si chiude solo al SUCCESSO (`onDone`), e resta aperto sull'errore
 * perché chi ha premuto lo legga — `useTicketAction` non ha un callback di
 * successo.
 *
 * ⚠️ **Nessun controllo di ruolo, di proposito.** Una correzione non è un piano
 * nuovo: la chiede chiunque possa già lanciare un run sul ticket, operatore
 * compreso, e il cancello vero (PR aperta, di Stubwise, nessuna correzione
 * attiva) sta sul server — che lo dichiara in `cycle.canRequestCorrection`.
 */
export function useRequestCorrection(ticketId: string) {
  const { client } = useAuth();
  const online = useIsOnline();
  const { t } = useTranslation();
  const invalidate = useInvalidateAfterCorrection(ticketId);
  // Guardia SINCRONA contro il doppio tap: `isPending` arriva col render
  // successivo, quindi due tap nello stesso frame passerebbero entrambi — la
  // seconda richiesta prenderebbe `correction_in_flight` e il pannello
  // resterebbe aperto sull'errore anche se la prima è riuscita. Il ref si
  // rilascia nell'`onSettled` della mutazione (non in quello della singola
  // `mutate`, che non parte se il componente si smonta prima).
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: ({ repositoryId, note }: CorrectionInput) => {
      if (!client) return Promise.reject(new Error("useRequestCorrection richiede un client autenticato"));
      return client.tickets.requestCorrection(ticketId, repositoryId, note !== undefined ? { note } : {});
    },
    onSuccess: invalidate.all,
    onError: (error) => {
      if (error instanceof ApiError && error.code !== undefined && REQUEST_STALE_CODES.has(error.code)) invalidate.work();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  return {
    request: (input: CorrectionInput, onDone: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutation.mutate(input, { onSuccess: onDone });
    },
    isPending: mutation.isPending,
    online,
    disabled: !online || mutation.isPending,
    errorMessage: mutation.error ? describeCorrectionError(mutation.error, t) : null,
    // Il metodo di `useMutation`, già stabile (vedi il commento gemello in `work-mutations.ts`).
    reset: mutation.reset,
  };
}

/**
 * «RIPRENDI» UNA CORREZIONE FERMA (G5): run-ai con `resumeCorrectionJobId`,
 * cioè il `cycle.heldJobId` che la schermata mostrava. Il server la forza solo
 * se quel job è ancora l'ultimo del ticket e ancora `held`.
 *
 * Una mutazione a sé e non un'opzione in più di `useRunAi`, per tre ragioni:
 * vuole un `onDone` (chi l'ha aperta si chiude solo al successo, come
 * `useRequestCorrection`), le sue frasi d'errore sono quelle del ciclo, e la
 * sua regola d'invalidazione è DIVERSA da quella dell'helper di `useRunAi`
 * (che rilegge su ogni 409).
 *
 * ⚠️ `heldJobId` è una `string`, non `string | null`: chi monta «Riprendi» lo
 * offre solo con `cycle.canResume` E `cycle.heldJobId` (il server li legge,
 * l'app no). Senza `heldJobId` il bottone non c'è — un run-ai senza il campo,
 * o un server precedente a G5 che lo ignora, farebbe un fix nuovo.
 *
 * Su 409 `correction_not_held` si ricarica il ticket: la correzione non è più
 * quella ferma, e la frase mostrata («il ticket è stato ricaricato») mentirebbe
 * se non lo si facesse. Su `job_in_flight` — stesso status, altro `code` — NO,
 * come `pr-cycle-row.tsx` del web.
 */
export function useResumeCorrection(ticketId: string) {
  const { client } = useAuth();
  const online = useIsOnline();
  const { t } = useTranslation();
  const invalidate = useInvalidateAfterCorrection(ticketId);
  // Stessa guardia sincrona di `useRequestCorrection`: due tap nello stesso
  // frame non devono mandare due run-ai.
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: (heldJobId: string) => {
      if (!client) return Promise.reject(new Error("useResumeCorrection richiede un client autenticato"));
      return client.tickets.runAi(ticketId, { resumeCorrectionJobId: heldJobId });
    },
    onSuccess: invalidate.all,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "correction_not_held") invalidate.work();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  return {
    /**
     * `true` se la richiesta è PARTITA, `false` se la guardia l'ha scartata
     * perché un'altra era già in volo. Chi monta «Riprendi» su più righe lo
     * usa per ricordare QUALE riga ha davvero premuto: due tap su righe
     * diverse nello stesso frame mandano una richiesta sola, e l'esito va
     * sotto la riga di quella, non dell'ultimo tap.
     */
    resume: (heldJobId: string, onDone: () => void): boolean => {
      if (inFlight.current) return false;
      inFlight.current = true;
      mutation.mutate(heldJobId, { onSuccess: onDone });
      return true;
    },
    isPending: mutation.isPending,
    online,
    disabled: !online || mutation.isPending,
    errorMessage: mutation.error ? describeCorrectionError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}
