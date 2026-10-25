import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  useConnectGoogle,
  useDisconnectGoogle,
  useGoogleAccount,
  useMyFolderLinks,
  useSessionPersonId,
} from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import { Dialog } from "../../tasks-ui/Dialog";
import { formatDate } from "../../notifications/time";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { GoogleDriveGlyph, Spinner, WarningGlyph } from "./glyphs";

// L'account Google personale (shape drive-google.md §3, A1): un dialogo
// aperto dal menu del profilo, finché il desktop non ha Impostazioni →
// Account. Tre stati — non collegato, collegato, scaduto — più il
// collegamento in corso (il ritardo simulato) e l'errore. Scollegare dice
// prima, contandole, quali cartelle smettono di aggiornarsi e chi può
// rimediare. Qui anche il passo «Connect your Google account first» che i
// dialoghi di collegamento e di «Add from Google Drive» mostrano a chi non
// ha l'account.

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Apre la scheda dell'account Google (menu del profilo). */
export function openGoogleAccount(): void {
  open = true;
  emit();
}

/** La chiude (Close, Esc, cambio di persona, test). */
export function closeGoogleAccount(): void {
  if (!open) return;
  open = false;
  emit();
}

// Cambio di persona: l'account (e l'email) di chi guardava prima non resta a schermo.
onBeforePersonaChange(closeGoogleAccount);

function useAccountOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

/** Montato dal layout: la scheda dell'account sopra qualunque pagina. */
export function GoogleAccountHost() {
  const me = useSessionPersonId();
  if (!useAccountOpen()) return null;
  return <GoogleAccountDialog key={me} onClose={closeGoogleAccount} />;
}

/** Collegare (o ricollegare) l'account: il ritardo simulato e l'errore con «Try again». */
function useConnect() {
  const connect = useConnectGoogle();
  return {
    run: () => connect.mutate(),
    pending: connect.isPending,
    failed: connect.isError,
  };
}

/** Il bottone che collega l'account: «Connecting to Google…» mentre lavora, l'errore con «Try again». */
function ConnectButton({ label, primary = true }: { label: string; primary?: boolean }) {
  const { t } = useTranslation();
  const connect = useConnect();
  if (connect.pending) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
        <Spinner />
        {t("drive.connect.connecting")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        data-autofocus
        className={primary ? primaryButton : secondaryButton}
        onClick={connect.run}
      >
        {connect.failed ? t("drive.connect.tryAgain") : label}
      </button>
      {connect.failed && (
        <p role="alert" className="text-sm text-critical">
          {t("drive.connect.error")}
        </p>
      )}
    </div>
  );
}

/**
 * Il primo passo di un dialogo Google per chi non ha l'account collegato (o
 * l'ha scaduto): collegato, il dialogo prosegue da solo (l'account si rilegge).
 */
export function ConnectGoogleStep() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <span className="text-ink-muted">
        <GoogleDriveGlyph size={24} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-md font-semibold text-ink">{t("drive.connect.first")}</p>
        <p className="max-w-[56ch] text-sm text-ink-muted">{t("drive.connect.body")}</p>
      </div>
      <ConnectButton label={t("drive.connect.button")} />
    </div>
  );
}

function GoogleAccountDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const account = useGoogleAccount();
  const [confirming, setConfirming] = useState(false);
  const mine = useMyFolderLinks(confirming).data;
  const disconnect = useDisconnectGoogle();
  const data = account.data;

  const doDisconnect = () =>
    disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) });

  let body;
  if (account.isPending) {
    body = (
      <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2 py-1">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        <span className="h-3 w-3/5 rounded-sm bg-ink/8" />
        <span className="h-2.5 w-1/4 rounded-sm bg-ink/8" />
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p className="max-w-[56ch] text-md text-ink">{t("drive.account.intro")}</p>
        <ConnectButton label={t("drive.connect.button")} />
        <p className="text-xs text-ink-faint">{t("drive.account.note")}</p>
      </div>
    );
  } else if (data.status === "expired") {
    body = (
      <div className="flex flex-col items-start gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-warning">
            <WarningGlyph />
          </span>
          <div className="flex flex-col gap-0.5">
            <p className="text-md font-semibold text-ink">
              {t("drive.account.expired", { date: formatDate(data.since, i18n.language) })}
            </p>
            <p className="text-sm text-ink-muted">{data.email}</p>
            <p className="text-sm text-ink-muted">{t("drive.account.expiredBody")}</p>
          </div>
        </div>
        <ConnectButton label={t("drive.account.reconnect")} />
      </div>
    );
  } else {
    const names = (mine ?? []).map((l) => l.name).join(", ");
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="text-ink-muted">
            <GoogleDriveGlyph size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-md font-semibold text-ink">
              {t("drive.account.connected", { email: data.email })}
            </p>
            <p className="num text-sm text-ink-muted">
              {t("drive.account.since", { date: formatDate(data.since, i18n.language) })}
            </p>
          </div>
          {!confirming && (
            <button type="button" className={secondaryButton} onClick={() => setConfirming(true)}>
              {t("drive.account.disconnect")}
            </button>
          )}
        </div>
        {confirming && (
          <div role="group" aria-label={t("drive.account.disconnect")} className="flex flex-col gap-2 border-t border-rule pt-4">
            {mine === undefined ? (
              <p className="text-sm text-ink-muted">{t("taskUi.states.loading")}</p>
            ) : (
              <>
                <p className="text-md text-ink">
                  {mine.length > 0
                    ? t("drive.account.disconnectFolders", { count: mine.length, names })
                    : t("drive.account.disconnectNone")}
                </p>
                {mine.length > 0 && (
                  <p className="text-sm text-ink-muted">{t("drive.account.disconnectWho")}</p>
                )}
              </>
            )}
            {disconnect.isError && (
              <p role="alert" className="text-sm text-critical">
                {t("drive.google.failed")}
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-ink-faint">{t("drive.account.note")}</p>
      </div>
    );
  }

  return (
    <Dialog
      title={t("drive.account.title")}
      onClose={onClose}
      width={480}
      footer={
        confirming && data?.status === "connected" ? (
          <>
            <button type="button" className={secondaryButton} onClick={() => setConfirming(false)}>
              {t("drive.account.cancel")}
            </button>
            <button
              type="button"
              data-autofocus
              disabled={mine === undefined || disconnect.isPending}
              className={dangerSolidButton}
              onClick={doDisconnect}
            >
              {t("drive.account.disconnectConfirm")}
            </button>
          </>
        ) : (
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("drive.account.close")}
          </button>
        )
      }
    >
      {body}
    </Dialog>
  );
}
