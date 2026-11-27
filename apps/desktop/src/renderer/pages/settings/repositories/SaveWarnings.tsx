import { useTranslation } from "react-i18next";
import type { RepositorySaveWarning } from "../../../data/queries";

/**
 * Gli avvisi NON bloccanti di un salvataggio riuscito (revisione M1, come
 * `repository-save-warnings.tsx` del web vecchio, che sparirà): il salvataggio
 * c'è, ma qualcosa intorno non va. In `text-warning`, non in rosso: non è
 * fallito niente. Un codice che la pagina non conosce non arriva fin qui (lo
 * filtra il livello dati).
 */
export function SaveWarnings({
  warnings,
  provider,
}: {
  warnings: readonly RepositorySaveWarning[];
  provider: "github" | "bitbucket" | null;
}) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  return (
    <div data-save-warnings className="flex flex-col gap-1.5">
      {warnings.map((w) => (
        <p key={w} role="status" className="max-w-[72ch] text-sm text-pretty text-warning">
          {t(`settings.repos.saveWarnings.${w}`)}
          {w === "main_account_identity_unresolved" && provider === "bitbucket" && (
            <> {t("settings.repos.saveWarnings.mainIdentityBitbucket")}</>
          )}
        </p>
      ))}
    </div>
  );
}
