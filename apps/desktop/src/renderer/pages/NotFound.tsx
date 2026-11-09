import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** Un indirizzo che l'app non conosce: dice cosa è successo e porta alla Home. */
export function NotFound() {
  const { t } = useTranslation();
  return (
    <section className="page-header flex h-full flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{t("notFound.title")}</h1>
      <p className="text-md text-ink-muted">{t("notFound.body")}</p>
      <Link to="/home" className="text-md text-ink underline underline-offset-4">
        {t("notFound.backHome")}
      </Link>
    </section>
  );
}
