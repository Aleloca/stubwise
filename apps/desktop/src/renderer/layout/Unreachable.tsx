import { useTranslation } from "react-i18next";
import { primaryButton } from "../pages/tasks/controls";

/**
 * Stubwise non risponde (build app: rete assente, server giù, un 5xx su chi è
 * dentro). Non è «fuori»: niente pagina d'ingresso, una frase e «Retry».
 */
export function Unreachable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="grid h-full place-items-center bg-ground px-6 text-ink">
      <section role="alert" className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-xl font-semibold">{t("entry.unreachable.title")}</h1>
        <p className="text-md text-ink-muted">{t("entry.unreachable.body")}</p>
        <button type="button" className={primaryButton} onClick={onRetry}>
          {t("entry.unreachable.retry")}
        </button>
      </section>
    </main>
  );
}
