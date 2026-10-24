import { useTranslation } from "react-i18next";

/**
 * Destinazione non ancora costruita: titolo e una frase che dice cosa ci
 * starà (R-D3: mai «area N» né «non progettata» davanti a chi usa l'app),
 * nessuna decorazione. Un solo
 * sistema di titoli: l'h1 a 28 px nell'area di lavoro, su ogni destinazione
 * (le personali non ripetono il nome nella colonna, i progetti ci tengono
 * codice e nome mentre l'h1 dice la sezione).
 */
export function Placeholder({ titleKey, bodyKey }: { titleKey: string; bodyKey: string }) {
  const { t } = useTranslation();
  return (
    <section className="page-header flex h-full flex-col gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{t(titleKey)}</h1>
      <p className="text-md text-ink-muted">{t(bodyKey)}</p>
    </section>
  );
}
