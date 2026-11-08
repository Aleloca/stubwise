import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { translateApiError } from "../../lib/translate-api-error";
import { VaultError } from "../../lib/vault/unlock";
import { useVault } from "../../lib/vault/vault-context";
import { actionButtonClass, actionPrimaryClass, ModalShell } from "../backlog/modal";

/** Il messaggio di un errore dello sblocco (o dell'attivazione). */
export function vaultErrorMessage(cause: unknown, t: TFunction): string {
  if (cause instanceof VaultError) return t(`vault:errors.${cause.code}`);
  return translateApiError(cause, t);
}

/**
 * Passkey senza PRF (Review Focus 5): lo dice, e porta dove se ne aggiunge
 * una compatibile. Nessuna chiave è stata creata.
 */
export function VaultUnsupportedNotice() {
  const { t } = useTranslation();
  return (
    <div role="alert" className="rounded-sm border border-signal/40 bg-signal/10 p-3 text-sm">
      <p>{t("vault:unsupported.body")}</p>
      <Link to="/settings/security" className="mt-2 inline-block text-signal underline">
        {t("vault:unsupported.link")}
      </Link>
    </div>
  );
}

/**
 * Il dialogo che apre la cassaforte: una passkey, e — alla prima volta — la
 * creazione della chiave personale. Si chiude da solo quando la cassaforte è
 * aperta. Lo usano le sezioni che leggono o scrivono credenziali.
 */
export function UnlockDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const vault = useVault();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nessuna passkey apre più la chiave: l'uscita è ricrearla, su richiesta.
  const [noSeal, setNoSeal] = useState(false);

  useEffect(() => {
    if (vault.state === "unlocked") onClose();
  }, [vault.state, onClose]);

  async function attempt(run: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await run();
    } catch (cause) {
      if (cause instanceof VaultError && cause.code === "no_seal") setNoSeal(true);
      setError(vaultErrorMessage(cause, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalShell titleId="vault-unlock-title" onClose={onClose}>
      <h2 id="vault-unlock-title" className="text-lg font-semibold">
        {t("vault:unlock.title")}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        {vault.state === "no_key" ? t("vault:unlock.firstTime") : t("vault:unlock.subtitle")}
      </p>
      {vault.state === "inactive" && (
        <p className="mt-3 text-sm text-fg-muted">{t("vault:unlock.inactive")}</p>
      )}
      {vault.state === "unsupported" && (
        <div className="mt-3">
          <VaultUnsupportedNotice />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {noSeal && (
        <div className="mt-3 rounded-sm border border-danger/40 bg-danger/10 p-3 text-sm">
          <p>{t("vault:recreate.warning")}</p>
          <button
            type="button"
            onClick={() => void attempt(vault.recreateKey)}
            disabled={pending}
            className={`${actionButtonClass} mt-2`}
          >
            {t("vault:recreate.action")}
          </button>
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className={actionButtonClass}>
          {t("vault:unlock.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void attempt(vault.unlock)}
          disabled={pending || vault.state === "inactive"}
          className={actionPrimaryClass}
        >
          {pending ? t("vault:unlock.pending") : t("vault:unlock.action")}
        </button>
      </div>
    </ModalShell>
  );
}
