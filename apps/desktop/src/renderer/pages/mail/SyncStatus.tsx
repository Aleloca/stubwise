import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGoogleAccount, useSyncMailbox } from "../../data/queries";
import type { MailboxView } from "../../data/types";
import { WorkingRing } from "../claude/conversation/parts";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { dayLabel, minutesSince } from "./format";
import { AlertGlyph, ClockGlyph } from "./glyphs";

// L'allineamento con Gmail (shape mail.md §5): per casella, nella colonna
// (solo parole) e nella riga di stato dell'elenco (parole e azione). «In
// corso» lo dice la casella (`sync: "syncing"`), non la mutazione: resta
// vero anche se l'«Aggiorna» l'ha premuto un'altra vista.

export type SyncPhase = "expired" | "failed" | "syncing" | "stale" | "ok";

export function syncPhase(box: MailboxView): SyncPhase {
  if (box.expired) return "expired";
  if (box.sync === "syncing") return "syncing";
  if (box.sync === "failed") return "failed";
  return box.stale ? "stale" : "ok";
}

const RANK: Record<SyncPhase, number> = { expired: 5, failed: 4, syncing: 3, stale: 2, ok: 1 };

/** La casella che sta peggio: con «Tutte le caselle» la riga di stato parla di lei. */
export function worstMailbox(boxes: readonly MailboxView[]): MailboxView | undefined {
  return [...boxes].sort((a, b) => RANK[syncPhase(b)] - RANK[syncPhase(a)])[0];
}

function useUpdatedLabel() {
  const { t, i18n } = useTranslation();
  return (iso: string) => {
    const minutes = minutesSince(iso);
    if (minutes < 1) return t("mail.sync.justNow");
    if (minutes < 60) return t("mail.sync.minutes", { count: minutes });
    if (minutes < 24 * 60) return t("mail.sync.hours", { count: Math.floor(minutes / 60) });
    return t("mail.sync.on", { date: dayLabel(iso, i18n.language) });
  };
}

const linkBase =
  "rounded-sm font-medium underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink disabled:opacity-40";
const link = `${linkBase} text-ink`;

/** La seconda linea di una casella nella colonna: solo lo stato, in parole. */
export function SyncLine({ box }: { box: MailboxView }) {
  const { t } = useTranslation();
  const updated = useUpdatedLabel();
  const phase = syncPhase(box);
  const base = "flex min-w-0 items-center gap-1 text-xs";
  switch (phase) {
    case "expired":
      return (
        <span className={`${base} text-critical`}>
          <AlertGlyph />
          {t("mail.sync.expired")}
        </span>
      );
    case "syncing":
      return (
        <span className={`${base} text-ink-muted`}>
          <WorkingRing size={10} />
          {t("mail.sync.updating")}
        </span>
      );
    case "failed":
      return (
        <span className={`${base} text-critical`}>
          <AlertGlyph />
          {t("mail.sync.failed")}
        </span>
      );
    case "stale":
      return (
        <span className={`${base} text-warning`}>
          <ClockGlyph />
          {updated(box.syncedAt)}
        </span>
      );
    default:
      return <span className={`${base} text-ink-faint`}>{updated(box.syncedAt)}</span>;
  }
}

/**
 * La riga di stato dell'elenco (28 px): quanto è aggiornata la casella e
 * l'azione che serve — «Refresh», «Refresh now» se è vecchia, «Try again»
 * se non è riuscita, «Reconnect» se il collegamento è scaduto. `prefix`:
 * l'indirizzo, quando la riga parla di una fra più caselle.
 */
export function SyncStatus({ box, prefix }: { box: MailboxView; prefix?: boolean }) {
  const { t } = useTranslation();
  const updated = useUpdatedLabel();
  const sync = useSyncMailbox();
  // Dal clic finché la casella non cambia (o la richiesta finisce) si dice
  // «Updating…»: l'allineamento simulato può chiudersi prima che la casella
  // riletta mostri `syncing`, e il clic non deve restare senza risposta.
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const requested = requestedAt !== null && requestedAt === box.syncedAt && !box.expired;
  const phase = requested ? "syncing" : syncPhase(box);
  const refresh = () => {
    setRequestedAt(box.syncedAt);
    sync.mutate(box.email, { onSettled: () => setRequestedAt(null) });
  };
  const who = prefix ? <span className="min-w-0 truncate">{box.email} ·</span> : null;
  const base = "flex h-7 min-w-0 shrink-0 items-center gap-1.5 px-4 text-xs";
  return (
    <div data-sync={phase} role="status" className={`${base} ${TONE[phase]}`}>
      {who}
      {phase === "expired" && (
        <>
          <AlertGlyph />
          <span className="truncate">{t("mail.sync.expired")}</span>·
          <button type="button" className={link} onClick={() => openGoogleAccount()}>
            {t("mail.sync.reconnect")}
          </button>
        </>
      )}
      {phase === "syncing" && (
        <>
          <WorkingRing size={10} />
          {t("mail.sync.updating")}
        </>
      )}
      {phase === "failed" && (
        <>
          <AlertGlyph />
          <span className="truncate">{t("mail.sync.failed")}</span>·
          <button type="button" className={link} onClick={refresh}>
            {t("mail.sync.tryAgain")}
          </button>
        </>
      )}
      {phase === "stale" && (
        <>
          <ClockGlyph />
          <span className="truncate">
            {t("mail.sync.behind", { updated: updated(box.syncedAt) })}
          </span>
          <button type="button" className={`${link} ml-auto shrink-0`} onClick={refresh}>
            {t("mail.sync.refreshNow")}
          </button>
        </>
      )}
      {phase === "ok" && (
        <>
          <span className="truncate">{updated(box.syncedAt)}</span>·
          <button type="button" className={`${linkBase} text-ink-muted hover:text-ink`} onClick={refresh}>
            {t("mail.sync.refresh")}
          </button>
        </>
      )}
    </div>
  );
}

const TONE: Record<SyncPhase, string> = {
  expired: "text-critical",
  failed: "text-critical",
  syncing: "text-ink-muted",
  stale: "text-warning",
  ok: "text-ink-faint",
};

/**
 * In testa all'elenco, con il collegamento scaduto: da quando, cosa non
 * succede più (posta nuova, invio da quell'indirizzo) e «Reconnect».
 * L'elenco sotto resta leggibile.
 */
export function ExpiredBanner({ box }: { box: MailboxView }) {
  const { t, i18n } = useTranslation();
  const account = useGoogleAccount().data;
  const since = account?.status === "expired" ? account.since : box.syncedAt;
  return (
    <div
      role="alert"
      data-expired-banner
      className="mx-4 mt-2 flex shrink-0 flex-col items-start gap-2 border-l border-critical py-1 pl-3 text-sm text-ink"
    >
      <p className="flex items-start gap-1.5">
        <span className="mt-0.5 text-critical">
          <AlertGlyph size={14} />
        </span>
        {t("mail.sync.expiredBanner", { date: dayLabel(since, i18n.language), email: box.email })}
      </p>
      <button
        type="button"
        onClick={() => openGoogleAccount()}
        className="inline-flex h-7 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        {t("mail.sync.reconnect")}
      </button>
    </div>
  );
}
