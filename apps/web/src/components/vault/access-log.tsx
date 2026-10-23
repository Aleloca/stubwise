import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../lib/format";
import { credentialAccessLogQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { FormError } from "../field";

/**
 * Registro delle letture del progetto (design «Mostrare e copiare»): chi ha
 * mostrato o copiato quale credenziale, e quando. Il chiamante lo monta solo
 * con `credentials.share` o `credentials.edit` nel progetto (un full admin
 * li ha); l'autorità resta il server, che risponde 403 agli altri. Si carica
 * solo quando lo si apre.
 */
export function AccessLog({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const log = useQuery({ ...credentialAccessLogQueryOptions(projectId), enabled: open });
  const items = log.data?.items ?? [];

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="self-start rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
      >
        {t("vault:credentials.log.open")}
      </button>
      {open &&
        (log.isPending ? (
          <p className="font-mono text-[12px] text-fg-faint">
            {t("vault:credentials.log.loading")}
          </p>
        ) : log.isError ? (
          <FormError message={translateApiError(log.error, t)} />
        ) : items.length === 0 ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("vault:credentials.log.empty")}</p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-line">
            <table
              aria-label={t("vault:credentials.log.title")}
              className="w-full text-left text-sm"
            >
              <thead className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
                <tr>
                  <th className="px-3 py-2">{t("vault:credentials.log.when")}</th>
                  <th className="px-3 py-2">{t("vault:credentials.log.who")}</th>
                  <th className="px-3 py-2">{t("vault:credentials.log.credential")}</th>
                  <th className="px-3 py-2">{t("vault:credentials.log.action")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap text-fg-faint">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-fg">{entry.userEmail}</td>
                    <td className="px-3 py-2 text-fg">{entry.credentialSnapshot}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-fg-muted">
                      {t(`vault:credentials.log.actions.${entry.action}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
