import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { adoptPr, releasePrAdoption, type PrAdoption } from "../lib/api";
import { ticketKeys } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

interface PrAdoptionPanelProps {
  ticketId: string;
  adoption: PrAdoption;
}

/** Tetto della nota, lo stesso di `adoptPrBodySchema` lato server. */
const NOTE_MAX_LENGTH = 4000;

/** I motivi che il catalogo conosce; un motivo nuovo di un server più recente cade su `unknown`. */
const KNOWN_REASONS = new Set(["fork", "stubwise_pr", "base_branch", "pr_closed"]);

const buttonClass =
  "rounded-sm border border-signal-dim px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-signal uppercase transition-colors hover:border-signal hover:bg-signal/10 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * ADOZIONE della PR di un ticket review (6 ott 2026): «Fai correggere a
 * Stubwise» e «Smetti di correggere».
 *
 * Tutto ciò che mostra lo DERIVA il server (`prAdoption`): lo stato, il
 * motivo per cui non si può, e soprattutto `canManage` — il bottone lo vede
 * solo un maintainer, e il client non lo deduce dal proprio ruolo (stesso
 * criterio di `canMerge`). Un operatore vede solo, se c'è, che Stubwise la
 * sta correggendo.
 *
 * Due passi per entrambe le azioni: l'adozione fa partire un run dell'agente
 * e scrive un commento sulla PR di un collega; il rilascio ferma il ciclo.
 *
 * ⚠️ Va keyato sul ticket: tiene stato locale (modulo aperto, nota).
 */
export function PrAdoptionPanel({ ticketId, adoption }: PrAdoptionPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [note, setNote] = useState("");
  // DIFESA NEL PUNTO DI LETTURA: `lib/api.ts` fa un cast, e un server più
  // vecchio non manda i campi col `.default()`.
  const canManage = adoption.canManage ?? false;
  const branch = adoption.branch ?? null;
  const reason = adoption.unavailableReason ?? null;
  const adoptedBy = adoption.adoptedBy ?? null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(ticketId) });
  };

  const adopt = useMutation({
    mutationFn: () => {
      const trimmed = note.trim();
      return adoptPr(ticketId, adoption.repositoryId, trimmed ? { note: trimmed } : {});
    },
    onSuccess: () => {
      setOpen(false);
      setNote("");
      invalidate();
    },
  });

  const release = useMutation({
    mutationFn: () => releasePrAdoption(ticketId, adoption.repositoryId),
    onSuccess: () => {
      setConfirmRelease(false);
      invalidate();
    },
  });

  // Appena affidata: nessuna correzione è partita — perché la review ha
  // approvato, o perché non è potuta partire. Sotto entrambi gli stati: il
  // dettaglio ricaricato può arrivare prima o dopo. `?? false`: cast, non parse.
  const afterAdopt =
    adopt.isSuccess && adopt.data.correctionId === null ? (
      <span role="status" className="min-w-0 font-mono text-[12px] wrap-anywhere text-fg-muted">
        {(adopt.data.reviewApproved ?? false)
          ? t("tickets:adoption.reviewApproved")
          : t("tickets:adoption.firstCorrectionNotStarted")}
      </span>
    ) : null;

  if (adoption.state === "adopted") {
    return (
      <div className="flex flex-col gap-2" data-testid="pr-adoption">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 font-mono text-[12px] wrap-anywhere text-signal">
            {adoptedBy !== null
              ? t("tickets:adoption.adopted", { who: adoptedBy })
              : t("tickets:adoption.adoptedNoWho")}
          </span>
          {canManage && !confirmRelease && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                release.reset();
                setConfirmRelease(true);
              }}
            >
              {t("tickets:adoption.release")}
            </button>
          )}
          {canManage && confirmRelease && (
            <>
              <button
                type="button"
                disabled={release.isPending}
                onClick={() => release.mutate()}
                className="rounded-sm bg-signal px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
              >
                {release.isPending ? t("tickets:adoption.releasing") : t("tickets:adoption.releaseConfirm")}
              </button>
              <button
                type="button"
                disabled={release.isPending}
                onClick={() => setConfirmRelease(false)}
                className="rounded-sm border border-line-strong px-3 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("tickets:adoption.cancel")}
              </button>
            </>
          )}
        </div>
        {release.isError && (
          <span role="alert" className="min-w-0 font-mono text-[12px] wrap-anywhere text-danger">
            {translateApiError(release.error, t)}
          </span>
        )}
        {afterAdopt}
      </div>
    );
  }

  // Non adottata: il bottone è affare di chi può decidere. Un operatore non
  // vede niente qui (il bottone non gli è mostrato, non solo disabilitato).
  if (!canManage) return null;

  const unavailable = adoption.state !== "available";
  const reasonKey = reason !== null && KNOWN_REASONS.has(reason) ? reason : "unknown";
  const noteId = `pr-adoption-note-${ticketId}`;

  return (
    <div className="flex flex-col gap-2" data-testid="pr-adoption">
      <p className="font-mono text-[12px] text-fg-muted">
        {unavailable ? t(`tickets:adoption.unavailable.${reasonKey}`) : t("tickets:adoption.available")}
      </p>
      {!open && (
        <div>
          <button
            type="button"
            disabled={unavailable || adopt.isPending}
            onClick={() => {
              adopt.reset();
              setOpen(true);
            }}
            className={buttonClass}
          >
            {t("tickets:adoption.adopt")}
          </button>
        </div>
      )}
      {open && !unavailable && (
        <div>
          <label htmlFor={noteId} className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("tickets:adoption.noteLabel")}
          </label>
          <textarea
            id={noteId}
            rows={3}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            disabled={adopt.isPending}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("tickets:adoption.notePlaceholder")}
            className="mt-1 w-full rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 text-sm text-fg transition-colors focus-visible:border-signal-dim"
          />
          <p className="mt-1 font-mono text-[11px] wrap-anywhere text-fg-muted">
            {branch !== null ? t("tickets:adoption.hint", { branch }) : t("tickets:adoption.hintNoBranch")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={adopt.isPending}
              onClick={() => adopt.mutate()}
              className="rounded-sm bg-signal px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
            >
              {adopt.isPending ? t("tickets:adoption.adopting") : t("tickets:adoption.confirm")}
            </button>
            <button
              type="button"
              disabled={adopt.isPending}
              onClick={() => {
                adopt.reset();
                setOpen(false);
              }}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("tickets:adoption.cancel")}
            </button>
          </div>
        </div>
      )}
      {adopt.isError && (
        <span role="alert" className="min-w-0 font-mono text-[12px] wrap-anywhere text-danger">
          {translateApiError(adopt.error, t)}
        </span>
      )}
      {afterAdopt}
    </div>
  );
}
