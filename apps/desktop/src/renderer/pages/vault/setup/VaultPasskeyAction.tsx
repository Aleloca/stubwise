import { vaultPagePath } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import * as setup from "@backend/vault-setup";
import { secondaryButton } from "../../tasks/controls";
import { useVaultSetupStatus } from "./useVaultSetup";

/**
 * Accanto a una passkey (Preferenze → Security, solo nella build web; design
 * §10): «Opens the vault» se la apre, altrimenti «Use for the vault», che
 * porta con una navigazione COMPLETA alla pagina a sé della cassaforte
 * (`/vault/#/passkeys`, revisione I-2): i due tocchi si fanno lì, con la
 * sua CSP. Senza una chiave viva aperta da un'altra passkey, niente.
 */
export function VaultPasskeyAction({ passkeyId, name }: { passkeyId: string; name: string }) {
  const { t } = useTranslation();
  const status = useVaultSetupStatus();
  const s = status.data;
  if (!setup.vaultSetupAvailable || !s || !s.activated || s.key === "none") return null;
  if (s.sealedPasskeyIds.includes(passkeyId))
    return <span className="shrink-0 text-sm text-ink-muted">{t("vault.setup.seal.sealed")}</span>;
  if (s.sealedPasskeyIds.length === 0) return null;
  return (
    <a className={secondaryButton} href={vaultPagePath("passkeys")} aria-label={t("vault.setup.seal.aria", { name })}>
      {t("vault.setup.seal.action")}
    </a>
  );
}
