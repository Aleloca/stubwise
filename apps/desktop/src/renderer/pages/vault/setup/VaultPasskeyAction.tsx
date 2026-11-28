import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as setup from "@backend/vault-setup";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { secondaryButton } from "../../tasks/controls";
import { setupErrorKey, useVaultChanged, useVaultSetupStatus } from "./useVaultSetup";

/**
 * «Use for the vault» accanto a una passkey (Preferenze → Sicurezza, solo
 * nella build web; design §10): una passkey registrata dopo la propria
 * chiave non la apre finché non ha il suo sigillo. Due tocchi: prima una
 * passkey che apre già la cassaforte, poi questa. Con la chiave viva e senza
 * sigillo il bottone; col sigillo una riga «Opens the vault»; senza chiave
 * niente (la chiave si crea dalla pagina della cassaforte).
 */
export function VaultPasskeyAction({ passkeyId, name }: { passkeyId: string; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const changed = useVaultChanged();
  const status = useVaultSetupStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  if (!setup.vaultSetupAvailable || !s || !s.activated || s.key === "none") return null;
  if (s.sealedPasskeyIds.includes(passkeyId))
    return <span className="shrink-0 text-sm text-ink-muted">{t("vault.setup.seal.sealed")}</span>;
  // Nessuna passkey apre la chiave: non c'è con cosa fare il primo tocco.
  if (s.sealedPasskeyIds.length === 0) return null;

  async function add() {
    setError(null);
    setBusy(true);
    const out = await setup.addPasskeyToVault(passkeyId);
    setBusy(false);
    if (out.ok) toast.show(t("vault.setup.seal.done", { name }));
    else if (out.code !== "passkey_failed") setError(out.code);
    await changed();
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        className={secondaryButton}
        aria-label={t("vault.setup.seal.aria", { name })}
        title={t("vault.setup.seal.hint")}
        disabled={busy}
        onClick={() => void add()}
      >
        {busy ? t("vault.setup.seal.pending") : t("vault.setup.seal.action")}
      </button>
      {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
    </span>
  );
}
