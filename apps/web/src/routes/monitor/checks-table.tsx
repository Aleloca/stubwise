import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteServerCheck, type CheckStatus, type ServerCheck } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { serverKeys } from "../../lib/queries";
import { Drawer } from "../../components/drawer";
import { CheckForm, RowButton } from "./server-admin";

const STATUS_CLASS: Record<CheckStatus, string> = {
  up: "text-ok",
  down: "text-danger",
  unknown: "text-fg-faint",
};

/**
 * Tabella dei check di servizio. Riga cliccabile: seleziona il check e ne mostra
 * lo storico latenza (il chiamante aggiunge `checkId` alla query metriche). Per
 * gli admin (`isAdmin`) la tabella diventa gestibile: "Aggiungi check" in testa
 * e modifica/elimina per riga (form in un sidepanel). La selezione per il grafico
 * latenza resta per tutti; i controlli di scrittura sono solo per gli admin (le
 * route API sono comunque `requireAdmin`).
 *
 * SICUREZZA: per i check DB il DSN non esce mai dall'API (`target` è vuoto,
 * `hasDsn` true) → si mostra l'etichetta "DSN cifrato", MAI il target.
 */
export function ChecksTable({
  serverId,
  checks,
  selectedCheckId,
  onSelect,
  isAdmin,
}: {
  serverId: string;
  checks: ServerCheck[];
  selectedCheckId: string | null;
  onSelect: (checkId: string) => void;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  // null = form chiuso; "new" = creazione; altrimenti il check in modifica.
  const [form, setForm] = useState<ServerCheck | "new" | null>(null);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:detail.checks.title")}
        </h2>
        {isAdmin && (
          <RowButton onClick={() => setForm("new")} label={t("monitor:servers.newCheck")} />
        )}
      </header>
      {checks.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
          {t("monitor:detail.checks.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-[12px]">
            <thead>
              <tr className="text-fg-faint">
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.name")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.type")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.target")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.status")}</th>
                <th className="px-4 py-2 text-right font-normal">{t("monitor:detail.checks.latency")}</th>
                {isAdmin && <th className="px-4 py-2 text-right font-normal" aria-hidden />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {checks.map((check) => {
                const selected = check.id === selectedCheckId;
                return (
                  // Riga interattiva raggiungibile da tastiera: tabIndex 0 +
                  // Enter/Space attivano la selezione come il click. Lo stato
                  // selezionato è esposto con `data-state` (aria-selected non è
                  // valido su una row di table, solo di grid). I bottoni admin
                  // nell'ultima cella NON attivano la selezione: il click su un
                  // <button> è ignorato dal gestore di riga, e la tastiera agisce
                  // sulla riga solo quando è la riga stessa ad avere il focus.
                  <tr
                    key={check.id}
                    tabIndex={0}
                    data-state={selected ? "selected" : undefined}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button")) return;
                      onSelect(check.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(check.id);
                      }
                    }}
                    className={`cursor-pointer transition-colors hover:bg-ink-850 focus-visible:outline-1 focus-visible:outline-signal-dim ${
                      selected ? "bg-ink-850" : ""
                    } ${check.lastStatus === "down" ? "border-l-2 border-l-danger" : ""}`}
                  >
                    <td className="px-4 py-2 text-fg">
                      {check.name}
                      {check.lastError && (
                        <span className="mt-0.5 block max-w-xs truncate text-[10px] text-danger">
                          {check.lastError}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{check.type}</td>
                    <td className="px-4 py-2 text-fg-muted">
                      {/* DB: mai il DSN, solo l'etichetta cifrata. */}
                      {check.hasDsn ? (
                        <span className="text-fg-faint italic">
                          {t("monitor:detail.checks.encryptedDsn")}
                        </span>
                      ) : (
                        <span className="truncate">{check.target || "—"}</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 ${STATUS_CLASS[check.lastStatus]}`}>
                      {t(`monitor:detail.checkStatus.${check.lastStatus}`)}
                      {check.lastStatus === "down" && check.downSince && (
                        <span className="ml-2 text-[10px] text-fg-faint">
                          {t("monitor:detail.checks.downSince", {
                            time: formatRelativeTime(check.downSince),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-fg-muted tabular-nums">
                      {check.lastLatencyMs === null ? "—" : `${check.lastLatencyMs} ms`}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-2">
                        <CheckRowActions
                          serverId={serverId}
                          check={check}
                          onEdit={() => setForm(check)}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form !== null && (
        <Drawer
          open
          onClose={() => setForm(null)}
          side="right"
          widthClassName="w-[min(92vw,32rem)]"
          aria-label={form === "new" ? t("monitor:servers.newCheck") : t("monitor:servers.edit")}
        >
          <div className="flex h-full flex-col overflow-y-auto">
            <header className="border-b border-line px-4 py-3">
              <h3 className="font-mono text-[12px] font-medium tracking-[0.14em] text-fg uppercase">
                {form === "new" ? t("monitor:servers.newCheck") : t("monitor:servers.saveCheck")}
              </h3>
            </header>
            <div className="px-4 py-4">
              <CheckForm
                serverId={serverId}
                check={form === "new" ? undefined : form}
                onDone={() => setForm(null)}
              />
            </div>
          </div>
        </Drawer>
      )}
    </section>
  );
}

/** Azioni admin per riga check: modifica (apre il form) ed elimina (conferma). */
function CheckRowActions({
  serverId,
  check,
  onEdit,
}: {
  serverId: string;
  check: ServerCheck;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const deletion = useMutation({
    mutationFn: () => deleteServerCheck(serverId, check.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverKeys.checks(serverId) });
    },
  });

  return (
    <div className="flex items-center justify-end gap-2">
      <RowButton onClick={onEdit} label={t("monitor:servers.edit")} />
      {confirming ? (
        <>
          <RowButton
            onClick={() => deletion.mutate()}
            disabled={deletion.isPending}
            label={t("monitor:servers.checkConfirm")}
            danger
          />
          <RowButton onClick={() => setConfirming(false)} label={t("common:cancel")} />
        </>
      ) : (
        <RowButton
          onClick={() => setConfirming(true)}
          label={t("monitor:servers.delete")}
          danger
        />
      )}
    </div>
  );
}
