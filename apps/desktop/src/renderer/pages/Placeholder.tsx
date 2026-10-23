import { useTranslation } from "react-i18next";

/**
 * Area non ancora progettata: titolo e una riga, nessuna decorazione.
 * `quiet` per le destinazioni personali, il cui nome è già il titolo della
 * colonna accanto: l'h1 resta (ogni pagina ne ha uno) ma a scala di testo,
 * così il primo colpo d'occhio non legge due volte «Home».
 */
export function Placeholder({ titleKey, quiet = false }: { titleKey: string; quiet?: boolean }) {
  const { t } = useTranslation();
  return (
    <section className={`flex h-full flex-col p-8 ${quiet ? "gap-1" : "gap-2"}`}>
      <h1 className={quiet ? "text-md font-semibold text-ink" : "text-2xl font-semibold text-ink"}>
        {t(titleKey)}
      </h1>
      <p className="text-md text-ink-muted">{t("placeholder.body")}</p>
    </section>
  );
}
