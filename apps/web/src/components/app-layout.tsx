import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { postLogout } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { Wordmark } from "./wordmark";

const NAV_ITEMS = [
  { to: "/tickets", label: "Tickets", code: "TKT" },
  { to: "/board", label: "Board", code: "BRD" },
  { to: "/projects", label: "Projects", code: "PRJ" },
  { to: "/team", label: "Team", code: "TEA" },
  { to: "/settings", label: "Settings", code: "SET" },
] as const;

/**
 * Layout autenticato: sidebar di navigazione a sinistra, contenuto a destra.
 * L'utente arriva qui solo dopo la guardia del router, quindi la query `me`
 * è già in cache e la suspense non scatta in pratica.
 */
export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(meQueryOptions);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await postLogout();
    } finally {
      // La cache va svuotata in ogni caso: il server pulisce comunque la
      // sessione best-effort e la UI non deve mostrare dati di un altro login.
      queryClient.clear();
      await navigate({ to: "/login" });
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-line bg-ink-900">
        <div className="border-b border-line px-5 py-4">
          <Link to="/tickets" className="inline-block">
            <Wordmark className="text-base" />
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group flex items-baseline gap-3 rounded-sm px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
              activeProps={{
                className: "bg-ink-800 text-fg shadow-[inset_2px_0_0_0_var(--color-signal)]",
              }}
            >
              {/* Il Link attivo espone data-status="active": la sigla si accende. */}
              <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint group-data-[status=active]:text-signal">
                {item.code}
              </span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* La documentazione è il sito Starlight servito da Caddy su /docs:
            link reale (anchor), non una route SPA. */}
        <a
          href="/docs/"
          className="group mx-3 mb-3 flex items-baseline gap-3 rounded-sm px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
        >
          <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint">DOC</span>
          Documentazione
        </a>

        <div className="border-t border-line p-3">
          <p
            className="truncate px-3 pb-2 font-mono text-[11px] text-fg-muted"
            title={data.user.email}
          >
            {data.user.email}
          </p>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full rounded-sm border border-line-strong px-3 py-1.5 text-left font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
          >
            {loggingOut ? "Uscita…" : "Esci"}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
