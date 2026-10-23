import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function ProjectNotFound() {
  const { t } = useTranslation();
  return (
    <section className="flex h-full flex-col items-start gap-2 p-8">
      <h1 className="text-2xl font-semibold text-ink">{t("project.notFound")}</h1>
      <p className="text-md text-ink-muted">{t("project.notFoundBody")}</p>
      <Link to="/home" className="text-md text-ink underline underline-offset-4">
        {t("project.backHome")}
      </Link>
    </section>
  );
}
