import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerWithKey } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { serversQueryOptions } from "../../lib/queries";
import { ServerCard } from "../../components/server-card";
import { KeyPanel, NewServerForm } from "./server-admin";

/**
 * Sezione Monitor: griglia di tutti i server monitorati, ognuno una
 * {@link ServerCard} (riusata dalla sezione Server del dettaglio progetto). La query è live
 * (`refetchInterval` 30s): stato, heartbeat e CPU si aggiornano da soli.
 * Gli admin registrano un nuovo server dall'header (form inline → guida chiave
 * one-shot nel sidepanel); per i member la view resta in sola lettura.
 */
export function MonitorListPage() {
  const { t } = useTranslation();
  const { data: servers } = useSuspenseQuery(serversQueryOptions());
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const [creating, setCreating] = useState(false);
  // Chiave rivelata (create): mostrata nel sidepanel, mai persistita.
  const [revealed, setRevealed] = useState<ServerWithKey | null>(null);

  return (
    <div className="page">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{t("monitor:list.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("monitor:list.subtitle")}</p>
        </div>
        {isAdmin && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("monitor:servers.newServer")}
          </button>
        )}
      </header>

      {isAdmin && creating && (
        <div className="mt-4 rounded-sm border border-line bg-ink-900 p-4">
          <NewServerForm
            onDone={() => setCreating(false)}
            onCreated={(server) => {
              setCreating(false);
              setRevealed(server);
            }}
          />
        </div>
      )}

      {servers.length === 0 && !creating ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("monitor:list.empty")}
          </p>
          <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
            {t("monitor:list.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}

      {revealed && <KeyPanel server={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}
