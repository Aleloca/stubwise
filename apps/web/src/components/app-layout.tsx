import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { postLogout } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { Avatar } from "./avatar";
import { Wordmark } from "./wordmark";

const NAV_ITEMS = [
  { to: "/tickets", labelKey: "common:nav.tickets", code: "TKT" },
  { to: "/board", labelKey: "common:nav.board", code: "BRD" },
  { to: "/projects", labelKey: "common:nav.projects", code: "PRJ" },
  { to: "/team", labelKey: "common:nav.team", code: "TEA" },
  { to: "/settings", labelKey: "common:nav.settings", code: "SET" },
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
  const { t, i18n } = useTranslation();
  const [loggingOut, setLoggingOut] = useState(false);

  // Allinea la lingua della UI alla preferenza persistita dell'utente: questo
  // layout monta su ogni pagina autenticata, quindi è il primo punto dopo il
  // login dove l'utente (con `language`) è disponibile. Pre-login si resta
  // sulla lingua iniziale (browser → it, altrimenti en).
  const userLanguage = data.user.language;
  useEffect(() => {
    if (i18n.language !== userLanguage) {
      void i18n.changeLanguage(userLanguage);
    }
  }, [i18n, userLanguage]);

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
              {t(item.labelKey)}
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
          {t("common:nav.docs")}
        </a>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 px-3 pb-2" title={data.user.email}>
            <Avatar src={data.user.avatarUrl} label={data.user.email} size={22} />
            <p className="truncate font-mono text-[11px] text-fg-muted">{data.user.email}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full rounded-sm border border-line-strong px-3 py-1.5 text-left font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
          >
            {loggingOut ? t("common:loggingOut") : t("common:logout")}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
