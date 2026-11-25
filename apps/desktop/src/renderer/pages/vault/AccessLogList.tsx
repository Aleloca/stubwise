import { useTranslation } from "react-i18next";
import type { AccessLogView } from "../../data/vault/types";

// Le righe del registro degli accessi (shape `vault.md` §3 «Access log»):
// data e ora in cifre tabellari · chi · (nel registro del progetto) la
// credenziale · l'azione · da dove, «from the Mac» / «from the browser»
// (D-8, VA-Q5). Lo stesso elenco nel dettaglio e nel registro del progetto.

export function AccessLogList({
  entries,
  showService = false,
}: {
  entries: AccessLogView[] | undefined;
  showService?: boolean;
}) {
  const { t } = useTranslation();
  if (entries && entries.length === 0)
    return <p className="text-sm text-ink-muted">{t("vault.detail.logEmpty")}</p>;
  return (
    <ul aria-label={t("vault.detail.log")} className="flex flex-col">
      {(entries ?? []).map((e) => (
        <li key={e.id} className="flex items-baseline gap-2 py-1 text-sm">
          <span className="num w-28 shrink-0 text-ink-muted">
            {new Date(e.at).toLocaleString(undefined, {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="text-ink">{e.name}</span>
          {showService && <span className="text-ink">{e.service}</span>}
          <span className="text-ink-muted">
            {t(`vault.detail.${e.action}`)} ·{" "}
            {e.via === "mac" ? t("vault.detail.fromMac") : t("vault.detail.fromBrowser")}
          </span>
        </li>
      ))}
    </ul>
  );
}
