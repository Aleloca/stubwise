import { useTranslation } from "react-i18next";
import type { GitProviderKind } from "@stubwise/shared";

/**
 * Avvisi NON bloccanti del salvataggio di una repository (D7): oggi solo
 * l'identità dell'account principale che non si legge — ogni "Request
 * changes" dalla piattaforma verrà scartato. Lo usano il dettaglio dopo un
 * PATCH e dopo la creazione (warnings arrivati con lo stato di navigazione).
 */
export function RepositorySaveWarnings({
  warnings,
  provider,
}: {
  warnings: readonly string[];
  provider: GitProviderKind;
}) {
  const { t } = useTranslation();
  if (!warnings.includes("main_account_identity_unresolved")) return null;
  // `text-signal` è l'ambra di `styles.css` (`--color-signal`): un avviso,
  // non un errore — `text-danger` direbbe che il salvataggio è fallito.
  return (
    <p role="status" className="mt-2 font-mono text-[12px] wrap-anywhere text-signal">
      {t("repositories:detail.mainIdentityWarning")}
      {provider === "bitbucket" && <> {t("repositories:detail.mainIdentityWarningBitbucket")}</>}
    </p>
  );
}
