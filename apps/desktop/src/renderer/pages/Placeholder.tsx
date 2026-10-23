import { useTranslation } from "react-i18next";

/**
 * Area non ancora progettata: titolo e una riga, nessuna decorazione. Un solo
 * sistema di titoli: l'h1 a 28 px nell'area di lavoro, su ogni destinazione
 * (le personali non ripetono il nome nella colonna, i progetti ci tengono
 * codice e nome mentre l'h1 dice la sezione).
 */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <section className="flex h-full flex-col gap-2 p-8">
      <h1 className="text-2xl font-semibold text-ink">{t(titleKey)}</h1>
      <p className="text-md text-ink-muted">{t("placeholder.body")}</p>
    </section>
  );
}
