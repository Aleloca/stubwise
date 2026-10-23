import { useTranslation } from "react-i18next";

/** Area non ancora progettata: titolo e una riga, nessuna decorazione. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <section className="flex h-full flex-col gap-2 p-8">
      <h1 className="text-2xl font-semibold text-ink">{t(titleKey)}</h1>
      <p className="text-md text-ink-muted">{t("placeholder.body")}</p>
    </section>
  );
}
