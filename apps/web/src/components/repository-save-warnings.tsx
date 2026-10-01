import { useTranslation } from "react-i18next";
import type { GitProviderKind } from "@stubwise/shared";

/**
 * Avvisi NON bloccanti del salvataggio di una repository (D7). Due:
 * - `main_account_identity_unresolved`: l'identità dell'account principale non
 *   si legge — ogni "Request changes" dalla piattaforma verrà scartato;
 * - `default_review_account_invalid`: il revisore PREDEFINITO, che su questa
 *   repository fa da revisore effettivo, non supera i controlli (scrittura,
 *   identità) — la review ricadrà su un commento del principale, senza
 *   verdetto. Non blocca: l'admin non l'ha scelto qui, e non esiste l'opzione
 *   «nessun revisore» per repository.
 * Lo usano il dettaglio dopo un PATCH e dopo la creazione (warnings arrivati
 * con lo stato di navigazione). Un codice che questo bundle non conosce (server
 * più nuovo) non si mostra.
 */
export function RepositorySaveWarnings({
  warnings,
  provider,
}: {
  warnings: readonly string[];
  provider: GitProviderKind;
}) {
  const { t } = useTranslation();
  const mainIdentity = warnings.includes("main_account_identity_unresolved");
  const defaultReview = warnings.includes("default_review_account_invalid");
  if (!mainIdentity && !defaultReview) return null;
  // `text-signal` è l'ambra di `styles.css` (`--color-signal`): un avviso,
  // non un errore — `text-danger` direbbe che il salvataggio è fallito.
  return (
    <>
      {mainIdentity && (
        <p role="status" className="mt-2 font-mono text-[12px] wrap-anywhere text-signal">
          {t("repositories:detail.mainIdentityWarning")}
          {provider === "bitbucket" && <> {t("repositories:detail.mainIdentityWarningBitbucket")}</>}
        </p>
      )}
      {defaultReview && (
        <p role="status" className="mt-2 font-mono text-[12px] wrap-anywhere text-signal">
          {t("repositories:detail.defaultReviewInvalidWarning")}
        </p>
      )}
    </>
  );
}
